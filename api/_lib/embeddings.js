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

module.exports = {
  embedText,
  embedTokens,
  isAvailable,
  MODEL,
  DIMS,
  // Test exports
  _cache: cache,
  _resetCache: () => cache.clear(),
};
