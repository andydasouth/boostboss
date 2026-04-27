/**
 * Boost Boss — Embedding Cache Worker
 *
 * Drains intent_embedding_misses, calls OpenAI in batch, promotes results
 * into intent_embedding_cache. Designed to run on a Vercel cron (every
 * 5–10 minutes) but also exposable as an admin-triggered endpoint for
 * one-shot seeding.
 *
 *   GET  /api/embed-cron                       → drain up to MAX tokens, embed, promote
 *   POST /api/embed-cron?action=seed           → seed with body.tokens (admin only)
 *   GET  /api/embed-cron?action=stats          → cache size + miss queue depth
 *
 * Auth:
 *   - Cron entry in vercel.json → Vercel attaches a CRON_SECRET that
 *     we verify via the x-vercel-signature header (or a static
 *     CRON_SECRET env var).
 *   - Admin actions accept BBX_ADMIN_KEY via Authorization header.
 *
 * Cost / capacity (text-embedding-3-small at $0.02 / 1M tokens):
 *   - 1 token avg ≈ 4 chars ≈ 1 OpenAI input token
 *   - Batch of 100 unique words = ~$0.000002. Negligible.
 *   - OpenAI batch endpoint accepts up to 2048 inputs per call.
 */

const MAX_TOKENS_PER_RUN = 500;     // limit OpenAI calls per cron tick
const OPENAI_BATCH_SIZE  = 200;     // per request to /v1/embeddings
const MODEL              = "text-embedding-3-small";
const DIMS               = 1536;

let _supabase = null;
function supa() {
  if (_supabase) return _supabase;
  if (!process.env.SUPABASE_URL) return null;
  if (!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)) return null;
  try {
    const { createClient } = require("@supabase/supabase-js");
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    );
    return _supabase;
  } catch (_) { return null; }
}

function authorised(req) {
  const h = req.headers || {};
  // Vercel cron sends an x-vercel-signature with CRON_SECRET, OR a
  // straight Authorization: Bearer header — accept either.
  if (process.env.CRON_SECRET) {
    if (h["x-vercel-signature"] === process.env.CRON_SECRET) return "cron";
    const auth = (h.authorization || "").replace(/^Bearer\s+/i, "");
    if (auth && auth === process.env.CRON_SECRET) return "cron";
  }
  if (process.env.BBX_ADMIN_KEY) {
    const auth = (h.authorization || "").replace(/^Bearer\s+/i, "");
    if (auth && auth === process.env.BBX_ADMIN_KEY) return "admin";
  }
  return null;
}

// Normalise then dedupe a list of tokens for OpenAI batching.
function normaliseTokens(tokens) {
  const seen = new Set();
  const out  = [];
  for (const raw of tokens || []) {
    const t = String(raw || "").trim().toLowerCase();
    if (!t || t.length > 64) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// Call OpenAI's batch embeddings endpoint. Returns a parallel array of
// 1536-dim vectors, or throws.
async function batchEmbed(tokens) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
    },
    body: JSON.stringify({ model: MODEL, input: tokens }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("OpenAI " + r.status + ": " + t.slice(0, 300));
  }
  const j = await r.json();
  if (!j || !Array.isArray(j.data) || j.data.length !== tokens.length) {
    throw new Error("OpenAI returned wrong shape (" + (j.data ? j.data.length : "?") + " vs " + tokens.length + ")");
  }
  return j.data.map((row) => row.embedding);
}

// Promote (tokens, vectors) into the cache via the SQL upsert RPC.
async function promote(sb, tokens, vectors) {
  // pgvector accepts the array as a JSON-encoded string literal.
  const asLiterals = vectors.map((v) => "[" + v.join(",") + "]");
  const { data, error } = await sb.rpc("bbx_promote_embeddings", {
    p_tokens:     tokens,
    p_embeddings: asLiterals,
  });
  if (error) throw new Error("promote: " + error.message);
  return Number(data) || tokens.length;
}

// ── Handlers ─────────────────────────────────────────────────────────

async function handleStats(sb, res) {
  const [cacheRes, missRes] = await Promise.all([
    sb.from("intent_embedding_cache").select("token", { count: "exact", head: true }),
    sb.from("intent_embedding_misses").select("token", { count: "exact", head: true }),
  ]);
  return res.status(200).json({
    cache_size:     cacheRes.count || 0,
    miss_queue:     missRes.count  || 0,
    model:          MODEL,
    dims:           DIMS,
    max_per_run:    MAX_TOKENS_PER_RUN,
    batch_size:     OPENAI_BATCH_SIZE,
  });
}

async function handleSeed(sb, body, res) {
  const tokens = normaliseTokens(body.tokens);
  if (tokens.length === 0) return res.status(400).json({ error: "tokens[] required" });
  if (tokens.length > 1000) return res.status(400).json({ error: "max 1000 tokens per seed call" });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "OPENAI_API_KEY not set" });

  let promoted = 0, failed = 0;
  for (let i = 0; i < tokens.length; i += OPENAI_BATCH_SIZE) {
    const slice = tokens.slice(i, i + OPENAI_BATCH_SIZE);
    try {
      const vecs = await batchEmbed(slice);
      promoted += await promote(sb, slice, vecs);
    } catch (e) {
      console.error("[embed-cron] seed batch failed:", e.message);
      failed += slice.length;
    }
  }
  return res.status(200).json({ requested: tokens.length, promoted, failed });
}

async function handleDrain(sb, res) {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: "OPENAI_API_KEY not set", drained: 0 });
  }
  // Pull the highest-priority misses (most miss_count first, then most recent).
  const { data: missRows, error } = await sb.from("intent_embedding_misses")
    .select("token")
    .order("miss_count", { ascending: false })
    .order("last_seen", { ascending: false })
    .limit(MAX_TOKENS_PER_RUN);
  if (error) return res.status(500).json({ error: error.message });

  const tokens = (missRows || []).map((r) => r.token).filter(Boolean);
  if (tokens.length === 0) {
    return res.status(200).json({ drained: 0, promoted: 0, message: "miss queue empty" });
  }

  let promoted = 0, failed = 0;
  for (let i = 0; i < tokens.length; i += OPENAI_BATCH_SIZE) {
    const slice = tokens.slice(i, i + OPENAI_BATCH_SIZE);
    try {
      const vecs = await batchEmbed(slice);
      promoted += await promote(sb, slice, vecs);
    } catch (e) {
      console.error("[embed-cron] drain batch failed:", e.message);
      failed += slice.length;
    }
  }
  return res.status(200).json({
    drained:  tokens.length,
    promoted, failed,
  });
}

// ── Entry ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const role = authorised(req);
  if (!role) return res.status(401).json({ error: "Unauthorised" });

  const sb = supa();
  if (!sb) return res.status(503).json({ error: "Supabase not configured" });

  const action = (req.query && req.query.action) || (req.body && req.body.action) || null;

  try {
    if (req.method === "GET" && action === "stats") return await handleStats(sb, res);
    if (req.method === "POST" && action === "seed") return await handleSeed(sb, req.body || {}, res);
    if (req.method === "GET" || req.method === "POST") return await handleDrain(sb, res);
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[embed-cron]", err);
    return res.status(500).json({ error: err.message });
  }
};
