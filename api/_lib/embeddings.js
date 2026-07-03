/**
 * Boost Boss — Voyage AI Embeddings helper
 *
 * Wraps voyage-3.5-lite (Anthropic/MongoDB's current lite embedding model,
 * pinned to 512 dims via output_dimension to match campaigns.intent_embedding
 * vector(512)). Bid-path lookups hit Postgres first.
 *
 *   • Campaign-side: when an advertiser saves target_intent_tokens, we
 *     embed once and persist into campaigns.intent_embedding (vector(512)).
 *   • Request-side (Stage 1): bid path calls lookupCachedEmbedding() —
 *     averages cached per-token vectors.
 *
 * EMBED-ON-MISS (2026-07): on a cache miss the bid path now embeds the new
 * token(s) inline (batched, timeout-bounded) and promotes them to
 * intent_embedding_cache, so the semantic tier self-primes without depending
 * on the embed_drain cron. Only the FIRST request that ever sees a token pays
 * the Voyage call; every later request hits Postgres. Disable with
 * EMBED_ON_MISS=0 to revert to cron-only priming. Still never blocks serving:
 * on timeout/failure it falls back to the async miss-queue + Jaccard.
 *
 * Both vectors flow into Benna.scorePrice as opts.requestEmbedding /
 * opts.campaignEmbedding, where intentMatchScore() takes the cosine
 * similarity path (clipped to [0.2, 1.5]) per protocol §9.
 *
 * If VOYAGE_API_KEY is unset, every embed helper resolves to null and
 * the caller falls back to the Jaccard implementation. The system
 * NEVER breaks because of a missing key — embeddings are an
 * optimisation, not a hard dependency.
 *
 * NOTE: request-side and campaign-side MUST use the same MODEL + DIMS or
 * cosine similarity is meaningless. campaigns.js VOYAGE_MODEL/VOYAGE_DIMS are
 * kept in lockstep with the constants here.
 */

const MODEL    = "voyage-3.5-lite";
const DIMS     = 512;
const ENDPOINT = "https://api.voyageai.com/v1/embeddings";
// Max time the bid path will wait on an inline embed-on-miss Voyage call
// before giving up and falling back to the async miss-queue + Jaccard.
const EMBED_ON_MISS_TIMEOUT_MS = 1500;

// In-memory LRU. Vercel reuses warm function instances so this stays
// hot across requests; cold starts pay one network call to re-prime.
const CACHE_MAX = 5000;
const cache     = new Map();   // key → { vec, ts }

function cacheGet(k) {
  if (!cache.has(k)) return null;
  const v = cache.get(k);
  cache.delete(k); cache.set(k, v);   // LRU bump
  return v.vec;
}
function cacheSet(k, vec) {
  if (cache.size >= CACHE_MAX) {
    // Drop oldest by deleting the first iteration entry
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(k, { vec, ts: Date.now() });
}

function hashKey(text) {
  // Cheap deterministic hash — collision risk is acceptable here because
  // a collision just produces a wrong (but still valid) embedding for an
  // unusual token combination, which Benna's clipping limits.
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return MODEL + ":" + (h >>> 0).toString(36) + ":" + text.length;
}

function normaliseTokens(tokens) {
  return (Array.isArray(tokens) ? tokens : [])
    .map((t) => String(t || "").trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function isAvailable() {
  return Boolean(process.env.VOYAGE_API_KEY);
}

/**
 * Embed an arbitrary text string. Returns a 1536-dim number[] or null
 * if disabled / failed. Single API call; cached.
 */
async function embedText(text) {
  if (!isAvailable()) return null;
  const t = String(text || "").trim();
  if (!t) return null;

  const k = hashKey(t);
  const hit = cacheGet(k);
  if (hit) return hit;

  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.VOYAGE_API_KEY,
      },
      // Voyage accepts an array OR string for `input`; we send an array
      // so the same call shape works whether we batch or single-shot.
      // output_dimension pins voyage-3.5-lite to 512 dims (its default is
      // 1024) so vectors match the vector(512) column + campaign embeddings.
      body: JSON.stringify({ model: MODEL, input: [t], output_dimension: DIMS }),
    });
    if (!r.ok) {
      console.error("[embeddings] Voyage", r.status, await r.text().catch(() => ""));
      return null;
    }
    const j = await r.json();
    const vec = j && j.data && j.data[0] && j.data[0].embedding;
    if (!Array.isArray(vec) || vec.length !== DIMS) {
      console.error("[embeddings] bad shape from Voyage");
      return null;
    }
    cacheSet(k, vec);
    return vec;
  } catch (e) {
    console.error("[embeddings] fetch failed:", e.message);
    return null;
  }
}

/**
 * Embed an array of intent tokens. Tokens are normalised + sorted so
 * the same set in a different order hits the same cache entry.
 * Returns null when no usable input or when VOYAGE_API_KEY is unset.
 */
async function embedTokens(tokens) {
  const norm = normaliseTokens(tokens);
  if (norm.length === 0) return null;
  return await embedText(norm.join(" "));
}

// ──────────────────────────────────────────────────────────────────────
// HOT-PATH CACHE LOOKUP (Stage 1 — OpenAI off the bid path)
// ──────────────────────────────────────────────────────────────────────
//
// At bid time we don't call OpenAI. Instead we:
//   1. Normalise the request's intent tokens.
//   2. Look them all up in intent_embedding_cache via a single indexed
//      Postgres query (sub-5ms).
//   3. Average the returned vectors → request_intent_embedding.
//   4. Fire-and-forget log any tokens that missed so /api/embed-cron
//      will pick them up on the next run.
//
// Net effect: zero external network calls during auctions. Postgres
// query latency only.

let _cachedSupa = null;
function _supa() {
  if (_cachedSupa) return _cachedSupa;
  if (!process.env.SUPABASE_URL) return null;
  if (!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)) return null;
  try {
    const { createClient } = require("@supabase/supabase-js");
    _cachedSupa = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    );
    return _cachedSupa;
  } catch (_) { return null; }
}

// Average N vectors of equal length. Returns null if the input is empty.
// Used at bid time to compose a multi-token context vector from per-token
// cache hits.
function averageVectors(vecs) {
  if (!Array.isArray(vecs) || vecs.length === 0) return null;
  const dim = vecs[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vecs) {
    if (!v || v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += Number(v[i]) || 0;
  }
  for (let i = 0; i < dim; i++) out[i] /= vecs.length;
  return out;
}

// Batch-embed tokens in ONE Voyage call, preserving input order. Returns an
// array aligned to `tokens` (each entry a vector or undefined), or null on
// failure/timeout. Used by embed-on-miss; timeout-bounded so it can never
// stall an auction.
async function embedMany(tokens) {
  if (!isAvailable()) return null;
  const list = (Array.isArray(tokens) ? tokens : [])
    .map((t) => String(t || "").trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMBED_ON_MISS_TIMEOUT_MS);
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.VOYAGE_API_KEY,
      },
      body: JSON.stringify({ model: MODEL, input: list, output_dimension: DIMS }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) { console.error("[embeddings] embedMany Voyage", r.status); return null; }
    const j = await r.json();
    if (!j || !Array.isArray(j.data) || j.data.length !== list.length) return null;
    // Realign to input order via the per-item index Voyage returns.
    return j.data.slice().sort((a, b) => (a.index || 0) - (b.index || 0)).map((row) => row.embedding);
  } catch (e) {
    clearTimeout(timer);
    console.error("[embeddings] embedMany:", e.message);
    return null;
  }
}

// Persist freshly-embedded tokens into intent_embedding_cache via the same
// RPC the cron uses (bbx_promote_embeddings), so future bids hit the cache.
async function _promoteToCache(sb, tokens, vectors) {
  const asLiterals = vectors.map((v) => "[" + v.join(",") + "]");
  const { error } = await sb.rpc("bbx_promote_embeddings", { p_tokens: tokens, p_embeddings: asLiterals });
  if (error) throw new Error(error.message);
}

// Fire-and-forget the miss queue so the cron can still pick up anything
// embed-on-miss didn't (or when embed-on-miss is disabled).
function _logMisses(sb, misses) {
  if (!misses || misses.length === 0) return;
  sb.rpc("bbx_log_embedding_misses", { p_tokens: misses })
    .then(() => {}).catch((e) => console.error("[embeddings] miss log:", e.message));
}

/**
 * Look up cached embeddings for a token list and return their average.
 * - Returns the averaged vector when at least one token hit (partial
 *   coverage is acceptable).
 * - With embed-on-miss (default when VOYAGE_API_KEY is set), missed tokens
 *   are embedded inline + promoted to the cache, so the semantic tier
 *   self-primes without the cron. Set EMBED_ON_MISS=0 for cron-only.
 * - Returns null when zero tokens resolve (caller falls back to Jaccard).
 */
async function lookupCachedEmbedding(tokens) {
  const norm = normaliseTokens(tokens);
  if (norm.length === 0) return null;
  const sb = _supa();
  if (!sb) return null;

  try {
    const { data, error } = await sb.from("intent_embedding_cache")
      .select("token, embedding")
      .in("token", norm);
    if (error) {
      console.error("[embeddings] cache lookup:", error.message);
      return null;
    }

    const hitTokens  = new Set();
    const hitVectors = [];
    for (const row of (data || [])) {
      hitTokens.add(row.token);
      // Supabase returns vectors as JSON-encoded "[...]" strings or as arrays
      // depending on driver version. Coerce both.
      let vec = row.embedding;
      if (typeof vec === "string") {
        try { vec = JSON.parse(vec); } catch (_) { vec = null; }
      }
      if (Array.isArray(vec) && vec.length === DIMS) hitVectors.push(vec);
    }

    const misses = norm.filter((t) => !hitTokens.has(t));
    if (misses.length > 0) {
      const onMiss = isAvailable() && process.env.EMBED_ON_MISS !== "0";
      if (onMiss) {
        // Embed the missing tokens inline (one batched, timeout-bounded call),
        // fold them into this request's vector, and persist for next time.
        const fresh = await embedMany(misses);
        if (Array.isArray(fresh)) {
          const okTokens = [], okVecs = [];
          for (let i = 0; i < misses.length; i++) {
            const v = fresh[i];
            if (Array.isArray(v) && v.length === DIMS) {
              hitVectors.push(v); okTokens.push(misses[i]); okVecs.push(v);
            }
          }
          if (okTokens.length > 0) {
            // Fire-and-forget the cache write — don't delay the auction on it.
            _promoteToCache(sb, okTokens, okVecs).catch((e) => console.error("[embeddings] promote:", e.message));
          }
          // Anything Voyage still didn't return → leave for the cron.
          const stillMissing = misses.filter((t, i) => !(Array.isArray(fresh[i]) && fresh[i].length === DIMS));
          _logMisses(sb, stillMissing);
        } else {
          // Voyage failed/timed out — fall back to the cron queue.
          _logMisses(sb, misses);
        }
      } else {
        _logMisses(sb, misses);
      }
    }

    return hitVectors.length > 0 ? averageVectors(hitVectors) : null;
  } catch (e) {
    console.error("[embeddings] lookup failed:", e.message);
    return null;
  }
}

module.exports = {
  embedText,
  embedTokens,
  embedMany,
  lookupCachedEmbedding,
  averageVectors,
  isAvailable,
  MODEL,
  DIMS,
  // Test exports
  _cache: cache,
  _resetCache: () => cache.clear(),
};
