/**
 * Boost Boss — OpenAI Embeddings helper
 *
 * Wraps text-embedding-3-small with an in-memory LRU cache so the bid
 * path doesn't pay a 50–100ms round-trip on every request. Used for:
 *
 *   • Campaign-side: when an advertiser saves target_intent_tokens, we
 *     embed once and persist into campaigns.intent_embedding (vector(1536)).
 *   • Request-side: each ad_request's intent_tokens get embedded at bid
 *     time, cached by sorted-token hash so identical contexts are free.
 *
 * Both vectors flow into Benna.scorePrice as opts.requestEmbedding /
 * opts.campaignEmbedding, where intentMatchScore() takes the cosine
 * similarity path (clipped to [0.2, 1.5]) per protocol §9.
 *
 * If OPENAI_API_KEY is unset, every helper resolves to null and the
 * caller falls back to the Jaccard implementation. The system NEVER
 * breaks because of a missing key — embeddings are an optimisation,
 * not a hard dependency.
 */

const MODEL    = "text-embedding-3-small";
const DIMS     = 1536;
const ENDPOINT = "https://api.openai.com/v1/embeddings";

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
  return Boolean(process.env.OPENAI_API_KEY);
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
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
      },
      body: JSON.stringify({ model: MODEL, input: t }),
    });
    if (!r.ok) {
      console.error("[embeddings] OpenAI", r.status, await r.text().catch(() => ""));
      return null;
    }
    const j = await r.json();
    const vec = j && j.data && j.data[0] && j.data[0].embedding;
    if (!Array.isArray(vec) || vec.length !== DIMS) {
      console.error("[embeddings] bad shape from OpenAI");
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
 * Returns null when no usable input or when OPENAI_API_KEY is unset.
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

/**
 * Look up cached embeddings for a token list and return their average.
 * - Returns the averaged vector when at least one token hit (partial
 *   coverage is acceptable; missed tokens are logged for the cron).
 * - Returns null when zero tokens hit (caller falls back to Jaccard).
 *
 * Also fires bbx_log_embedding_misses() in the background for any
 * tokens that weren't in the cache, so the cron picks them up.
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

    // Log misses async — never block the bid path on this RPC. We don't
    // even await the promise; just fire and forget.
    const misses = norm.filter((t) => !hitTokens.has(t));
    if (misses.length > 0) {
      sb.rpc("bbx_log_embedding_misses", { p_tokens: misses })
        .then(() => {})
        .catch((e) => console.error("[embeddings] miss log:", e.message));
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
  lookupCachedEmbedding,
  averageVectors,
  isAvailable,
  MODEL,
  DIMS,
  // Test exports
  _cache: cache,
  _resetCache: () => cache.clear(),
};
