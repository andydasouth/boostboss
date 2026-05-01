/**
 * Boost Boss — Benna Inference API
 *
 *   GET  /api/benna?op=engine-status&advertiser_id=xxx
 *        → aggregate engine metrics, top weighted signals, recent auto-adjustments
 *
 *   POST /api/benna                 (op=predict)
 *        body: { context: { intent_tokens[], active_tools[], host_app, surface,
 *                           intent, mcp_tool, host, region, session_len, ... },
 *                campaign: { target_intent_tokens[], target_active_tools[],
 *                            target_host_apps[], target_surfaces[],
 *                            target_keywords[], target_cpa, format } }
 *        → { bid, p_click, p_convert, signal_contributions[], latency_ms, model_version }
 *
 * scoreBid() scores a request × campaign by computing per-signal match strength
 * against the campaign's actual targeting columns (target_intent_tokens,
 * target_active_tools, target_host_apps, target_surfaces). It is NOT a learned
 * model — it's a deterministic targeting-overlap score with fixed weights.
 * Once we have outcome data, swap the per-signal weights for a learned table.
 *
 * Protocol §9 pricing lives in scorePrice() further down.
 */

const MODEL_VERSION = "benna-rc4-2026.05.01";

// Per-signal weights for scoreBid. These determine how much each targeting
// dimension contributes to the predicted p_click. Sum is ~1.0 by design so
// a fully-aligned campaign approaches the p_click ceiling.
const SCORE_WEIGHTS = {
  intent:  0.35,   // intent_tokens overlap (Jaccard)
  tool:    0.25,   // active_tools overlap (proportional)
  host:    0.18,   // host_app match (binary)
  surface: 0.12,   // surface match (binary)
  keyword: 0.10,   // legacy target_keywords overlap (kept for back-compat)
};

// Engine-status dashboard priors. Illustrative only — these drive the
// "what the engine has learned" weight bars on the advertiser dashboard.
// scoreBid() does NOT use these; they're a snapshot of typical winning
// signals for display purposes until live outcome data lands.
const SIGNAL_PRIORS = {
  "intent=debug_py":       { w: 0.34, bar: 94 },
  "tool=shell.exec":       { w: 0.22, bar: 61 },
  "host=cursor.com":       { w: 0.18, bar: 50 },
  "session_len>30m":       { w: 0.13, bar: 36 },
  "region=us-west":        { w: 0.09, bar: 26 },
  "tool=file.read":        { w: 0.07, bar: 20 },
  "intent=docs_lookup":    { w: 0.05, bar: 15 },
};

// ─── deterministic pseudo-random so panels look stable per-minute ───
function seeded(seed) {
  let x = (seed * 9301 + 49297) % 233280;
  return () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
}

function currentBucketSeed() {
  // rotates every 60 seconds so the dashboard feels alive on reload
  return Math.floor(Date.now() / 60000);
}

// ── helpers for scoreBid ───────────────────────────────────────────────
function asTokenSet(arr) {
  if (!Array.isArray(arr)) return new Set();
  const out = new Set();
  for (const t of arr) {
    if (t == null) continue;
    const s = String(t).toLowerCase().trim();
    if (s) out.add(s);
  }
  return out;
}

// Returns { matched: [...], jaccard: 0..1, overlap: count } for two arrays.
function tokenOverlap(reqArr, targetArr) {
  const req = asTokenSet(reqArr);
  const tgt = asTokenSet(targetArr);
  if (req.size === 0 || tgt.size === 0) {
    return { matched: [], jaccard: 0, overlap: 0 };
  }
  const matched = [];
  for (const t of tgt) if (req.has(t)) matched.push(t);
  const overlap = matched.length;
  const union = req.size + tgt.size - overlap;
  return { matched, jaccard: union === 0 ? 0 : overlap / union, overlap };
}

// Promote legacy single-value context fields to token arrays so the same
// scoring path works for both mcp.js (which passes {intent, mcp_tool, host})
// and rtb.js (which passes {intent_tokens[], active_tools[], host_app}).
function normalizeContext(ctx) {
  const out = { ...ctx };
  if (!Array.isArray(out.intent_tokens)) {
    out.intent_tokens = out.intent ? [String(out.intent)] : [];
  }
  if (!Array.isArray(out.active_tools)) {
    out.active_tools = out.mcp_tool ? [String(out.mcp_tool)] : [];
  }
  if (!out.host_app && out.host) {
    const h = String(out.host).toLowerCase();
    if (h.includes("cursor"))         out.host_app = "cursor";
    else if (h.includes("claude"))    out.host_app = "claude_desktop";
    else if (h.includes("vscode"))    out.host_app = "vscode";
    else if (h.includes("jetbrains")) out.host_app = "jetbrains";
  }
  return out;
}

// Format a "matched X out of Y" signal label for signal_contributions.
function fmtMatched(prefix, matched) {
  if (!matched || matched.length === 0) return prefix;
  const head = matched.slice(0, 3).join(",");
  return matched.length > 3 ? `${prefix}: ${head},+${matched.length - 3}` : `${prefix}: ${head}`;
}

// ─── core inference: targeting-overlap score ───
function scoreBid(context = {}, campaign = {}) {
  const ctx = normalizeContext(context);
  const rnd = seeded(
    hash(JSON.stringify(context) + (campaign.target_cpa || campaign.bid_amount || "") + currentBucketSeed())
  );

  // Per-signal jitter: ±15% so stable cohorts still show natural variance
  // across the dashboard's 60-second refresh cycle. Bounded so jitter
  // can't turn a no-match into a match or vice versa.
  const jitter = () => 0.85 + rnd() * 0.30;

  const contributions = [];
  // Aggregate signal score in [0, 1]. p_click is mapped from this below.
  let signalScore = 0;

  // ── intent_tokens (Jaccard over ctx.intent_tokens × campaign.target_intent_tokens)
  const intent = tokenOverlap(ctx.intent_tokens, campaign.target_intent_tokens);
  if (intent.overlap > 0) {
    const w = SCORE_WEIGHTS.intent;
    const strength = intent.jaccard;          // 0..1
    const lift = w * strength * jitter();
    signalScore += lift;
    contributions.push({
      signal: fmtMatched("intent", intent.matched),
      weight: +w.toFixed(3),
      lift: +(lift * 100).toFixed(1),
    });
  }

  // ── active_tools (proportional overlap)
  const tool = tokenOverlap(ctx.active_tools, campaign.target_active_tools);
  if (tool.overlap > 0) {
    const w = SCORE_WEIGHTS.tool;
    const tgtSize = (campaign.target_active_tools || []).length || 1;
    const strength = Math.min(1, tool.overlap / tgtSize);
    const lift = w * strength * jitter();
    signalScore += lift;
    contributions.push({
      signal: fmtMatched("tool", tool.matched),
      weight: +w.toFixed(3),
      lift: +(lift * 100).toFixed(1),
    });
  }

  // ── host_app (binary)
  const targetHosts = asTokenSet(campaign.target_host_apps);
  if (ctx.host_app && targetHosts.size > 0 && targetHosts.has(String(ctx.host_app).toLowerCase())) {
    const w = SCORE_WEIGHTS.host;
    const lift = w * jitter();
    signalScore += lift;
    contributions.push({
      signal: `host=${ctx.host_app}`,
      weight: +w.toFixed(3),
      lift: +(lift * 100).toFixed(1),
    });
  }

  // ── surface (binary)
  const targetSurfaces = asTokenSet(campaign.target_surfaces);
  if (ctx.surface && targetSurfaces.size > 0 && targetSurfaces.has(String(ctx.surface).toLowerCase())) {
    const w = SCORE_WEIGHTS.surface;
    const lift = w * jitter();
    signalScore += lift;
    contributions.push({
      signal: `surface=${ctx.surface}`,
      weight: +w.toFixed(3),
      lift: +(lift * 100).toFixed(1),
    });
  }

  // ── keyword (legacy target_keywords ∩ context_summary tokens / context.keywords)
  const ctxKeywordTokens = Array.isArray(ctx.keywords)
    ? ctx.keywords
    : (typeof ctx.context_summary === "string"
        ? ctx.context_summary.split(/\s+/).filter(Boolean)
        : []);
  const kw = tokenOverlap(ctxKeywordTokens, campaign.target_keywords);
  if (kw.overlap > 0) {
    const w = SCORE_WEIGHTS.keyword;
    const tgtSize = (campaign.target_keywords || []).length || 1;
    const strength = Math.min(1, kw.overlap / tgtSize);
    const lift = w * strength * jitter();
    signalScore += lift;
    contributions.push({
      signal: fmtMatched("keyword", kw.matched),
      weight: +w.toFixed(3),
      lift: +(lift * 100).toFixed(1),
    });
  }

  // Map aggregate signal score → p_click. Floor of 1% (cold-start), ceiling
  // of 12% (saturation cap). signalScore ∈ [0, ~1.0] when fully aligned.
  const P_CLICK_FLOOR = 0.01;
  const P_CLICK_CEIL  = 0.12;
  const p_click = Math.min(P_CLICK_CEIL, P_CLICK_FLOOR + signalScore * (P_CLICK_CEIL - P_CLICK_FLOOR));

  const p_convert = p_click * (0.18 + rnd() * 0.15);

  // bid = target_cpa × p_convert + small exploration noise (Thompson-ish)
  let target = parseFloat(campaign.target_cpa);
  if (!Number.isFinite(target) || target <= 0) target = 4.5;
  const explore = 1 + (rnd() - 0.5) * 0.08;
  const bid = +Math.max(0, target * p_convert * explore).toFixed(4);

  return {
    bid_usd: bid,
    p_click: +p_click.toFixed(4),
    p_convert: +p_convert.toFixed(4),
    signal_contributions: contributions.sort((a, b) => b.lift - a.lift),
    latency_ms: +(3.4 + rnd() * 1.8).toFixed(1),
    model_version: MODEL_VERSION,
  };
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ─── Protocol §9 — price model ─────────────────────────────────────────
// price_cpm = advertiser_bid_cpm
//           × placement_baseline_ctr
//           × geo_multiplier
//           × format_multiplier
//           × intent_match_score   (cosine of embeddings; Jaccard fallback)
//           × safety_multiplier    (1 unless brand-safety violation)
//
// All multipliers are bounded so a single bad signal can't blow up a bid.
// Defaults are the v0 priors; once we have outcome data, replace these
// constants with learned tables.

const GEO_MULTIPLIERS = {
  US: 1.00, CA: 0.95, GB: 0.90, AU: 0.90, JP: 0.85, DE: 0.80, FR: 0.75,
  KR: 0.80, SG: 0.85, NL: 0.80,
  // Tier-2
  IT: 0.55, ES: 0.50, BR: 0.30, MX: 0.30,
  // Emerging
  IN: 0.20, ID: 0.18, VN: 0.15, NG: 0.12,
  // Special bucket: "global" / unknown ⇒ 0.5
};
const GEO_DEFAULT = 0.50;

// Maps a placement.format (image|video|native|text_card) crossed with a
// placement.surface (chat|tool_response|sidebar|...) to a multiplier.
// Surface dominates: tool_response > chat > sidebar > web. Within a
// surface, video > native > image > banner.
function formatMultiplier(format, surface) {
  const surfaceTable = {
    tool_response:  1.40,   // sponsored result mixed into tool output (highest intent)
    chat:           1.00,
    sidebar:        0.65,
    loading_screen: 1.20,   // interstitial-equivalent
    status_line:    0.45,
    web:            0.85,
  };
  const formatTable = {
    video:     1.25,
    native:    1.00,
    image:     0.90,
    text_card: 0.95,
    banner:    0.80,
  };
  const sm = surface ? (surfaceTable[surface] ?? 1.0) : 1.0;
  const fm = format  ? (formatTable[format]   ?? 1.0) : 1.0;
  return +(sm * fm).toFixed(4);
}

function geoMultiplier(country) {
  if (!country) return GEO_DEFAULT;
  const code = String(country).toUpperCase().slice(0, 2);
  return GEO_MULTIPLIERS[code] ?? GEO_DEFAULT;
}

// Cosine similarity for two equal-length numeric arrays. Returns null
// if the inputs are unusable (lets caller fall back to Jaccard).
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return null;
  }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = +a[i], y = +b[i];
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Embedding-aware intent match. Tries cosine over the supplied embeddings
// first (text-embedding-3-small, 1536 dims), falls back to Jaccard over
// the raw token arrays. Output is clipped to [0.2, 1.5] per protocol §9.
function intentMatchScore(reqTokens, campaignTokens, opts = {}) {
  // Embedding path
  if (opts.requestEmbedding && opts.campaignEmbedding) {
    const sim = cosineSimilarity(opts.requestEmbedding, opts.campaignEmbedding);
    if (sim != null) {
      // sim ∈ [-1, 1] → clip negatives to 0 → rescale to [0.2, 1.5]
      const s = Math.max(0, Math.min(1, sim));
      return +Math.max(0.2, Math.min(1.5, 0.4 + s * 1.4)).toFixed(4);
    }
  }

  // Jaccard fallback (same shape as _lib/mcp_targeting.js so behaviour
  // is consistent whether the embedding is populated or not)
  const a = (reqTokens || []).map((t) => String(t).toLowerCase());
  const b = (campaignTokens || []).map((t) => String(t).toLowerCase());
  if (a.length === 0 || b.length === 0) return 1.0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  if (union === 0) return 1.0;
  const j = inter / union;
  return +Math.max(0.2, Math.min(1.5, 0.4 + j * 1.4)).toFixed(4);
}

// Brand-safety check: returns 1.0 unless the campaign is excluded by the
// placement's category or advertiser-domain blocklist. 0 = no bid.
function safetyMultiplier(campaign, placement) {
  const excludedCats = (placement && placement.excluded_categories) || [];
  const excludedAdv  = (placement && placement.excluded_advertisers) || [];
  const overlap = (a, b) => Array.isArray(a) && Array.isArray(b) && a.some((x) => b.includes(x));
  if (overlap(campaign.iab_cat, excludedCats)) return 0;
  if (overlap(campaign.adomain, excludedAdv))  return 0;
  return 1;
}

/**
 * Compute the auction price for one campaign × placement × request triple.
 * This is the protocol §9 entry point. mcp.js and rtb.js call this once
 * per eligible candidate and pick the highest price_cpm that clears the
 * placement floor.
 *
 * Input shape:
 *   {
 *     placement: { id, surface, format, floor_cpm,
 *                  excluded_categories, excluded_advertisers,
 *                  baseline_ctr },                       -- optional, default 1.0
 *     context:   { intent_tokens[], country, host_app, ... },
 *     campaign:  { bid_amount,                           -- advertiser's max CPM
 *                  format, target_intent_tokens, intent_embedding,
 *                  iab_cat, adomain },
 *     request_intent_embedding,                          -- optional cached vector
 *   }
 *
 * Output:
 *   {
 *     price_cpm,                   -- USD per 1000 impressions
 *     cleared_floor: bool,
 *     factors: { ... },            -- breakdown for debugging / dashboards
 *     latency_ms,
 *     model_version,
 *   }
 */
function scorePrice(req) {
  const t0 = process.hrtime ? process.hrtime.bigint() : null;
  const placement = req.placement || {};
  const context   = req.context   || {};
  const campaign  = req.campaign  || {};

  const advertiser_bid_cpm = Number(campaign.bid_amount) || 0;
  const baseline_ctr       = Number(placement.baseline_ctr) || 1.0;
  const geo_mult           = geoMultiplier(context.country);
  const format_mult        = formatMultiplier(
    campaign.format || placement.format,
    placement.surface
  );
  const intent_match = intentMatchScore(
    context.intent_tokens || [],
    campaign.target_intent_tokens || [],
    {
      requestEmbedding: req.request_intent_embedding,
      campaignEmbedding: campaign.intent_embedding,
    }
  );
  const safety_mult = safetyMultiplier(campaign, placement);

  const price_cpm = advertiser_bid_cpm
    * baseline_ctr
    * geo_mult
    * format_mult
    * intent_match
    * safety_mult;

  const floor_cpm = Number(placement.floor_cpm) || 0;
  const cleared_floor = price_cpm > 0 && price_cpm >= floor_cpm;

  let latency_ms = 0.1;
  if (t0 != null) {
    const t1 = process.hrtime.bigint();
    latency_ms = Number((t1 - t0) / 1000n) / 1000;
    if (!Number.isFinite(latency_ms) || latency_ms < 0.1) latency_ms = 0.1;
  }

  return {
    price_cpm: +price_cpm.toFixed(4),
    cleared_floor,
    factors: {
      advertiser_bid_cpm: +advertiser_bid_cpm.toFixed(4),
      baseline_ctr:       +baseline_ctr.toFixed(4),
      geo_multiplier:     +geo_mult.toFixed(4),
      format_multiplier:  +format_mult.toFixed(4),
      intent_match_score: intent_match,
      safety_multiplier:  safety_mult,
      floor_cpm:          +floor_cpm.toFixed(4),
    },
    latency_ms: +latency_ms.toFixed(2),
    model_version: MODEL_VERSION,
  };
}

// ─── engine status (what the advertiser dashboard pulls) ───
function engineStatus(advertiserId = "default") {
  const rnd = seeded(hash(advertiserId + currentBucketSeed()));

  const decisions = Math.floor(1_100_000 + rnd() * 380_000);
  const latency = +(3.8 + rnd() * 0.9).toFixed(1);
  const ecpa_lift = -(30 + Math.floor(rnd() * 14)); // −30..−44%

  // Signal weights with ±2% jitter so the bars breathe between polls
  const signals = Object.entries(SIGNAL_PRIORS)
    .slice(0, 5)
    .map(([name, prior]) => ({
      name,
      weight: +(prior.w + (rnd() - 0.5) * 0.02).toFixed(2),
      bar: Math.max(8, Math.min(98, prior.bar + Math.floor((rnd() - 0.5) * 8))),
    }));

  // Recent auto-adjustments — rotating pool
  const now = new Date();
  const tstamp = (minAgo) => {
    const d = new Date(now.getTime() - minAgo * 60000);
    return d.toTimeString().slice(0, 5);
  };

  const pool = [
    { m: 2, action: 'Raised bid on <code>intent=debug_py</code> <span class="pos">+18%</span> — CVR <span class="pos">+24%</span>' },
    { m: 14, action: 'Paused creative <code>cr_2f9a</code> — CTR <span class="neg">−61%</span> vs cohort' },
    { m: 27, action: 'Shifted spend to <strong>Cursor</strong> inventory <span class="pos">+$142</span>' },
    { m: 45, action: 'Lowered bid on <code>tool=search</code> <span class="neg">−9%</span> — cost/conv above target' },
    { m: 63, action: 'Expanded cohort <code>python-devs-advanced</code> <span class="pos">+2.1k</span> users' },
    { m: 80, action: 'Retrained weights · loss <span class="pos">−0.012</span> · AUC 0.91' },
    { m: 95, action: 'Added signal <code>host=replit.com</code> to model — weight <span class="pos">0.06</span>' },
    { m: 110, action: 'Capped exploration on <strong>Raycast</strong> — $3.10 CPM ceiling' },
  ];

  const start = Math.floor(rnd() * 2);
  const log = pool.slice(start, start + 6).map(e => ({
    time: tstamp(e.m),
    action: e.action,
  }));

  return {
    status: "optimizing",
    model_version: MODEL_VERSION,
    metrics: {
      decisions_24h: decisions,
      decisions_24h_fmt: `${(decisions / 1e6).toFixed(2)}M`,
      inference_p50_ms: latency,
      ecpa_lift_pct: ecpa_lift,
      ecpm_lift_pct: 47,
      auc: 0.91,
    },
    signals,
    log,
  };
}

// ─── handler ───
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const op = (req.query && req.query.op) || (req.body && req.body.op);

    // GET engine-status
    if (req.method === "GET" && (op === "engine-status" || !op)) {
      const advertiserId = (req.query && req.query.advertiser_id) || "default";
      return res.status(200).json(engineStatus(advertiserId));
    }

    // POST predict — legacy signal-based bid scoring
    if (req.method === "POST" && (op !== "price")) {
      const body = req.body || {};
      const context = body.context || {};
      const campaign = body.campaign || {};
      const result = scoreBid(context, campaign);
      return res.status(200).json(result);
    }

    // POST price — protocol §9 price model (placement-aware, with floor)
    if (req.method === "POST" && op === "price") {
      const body = req.body || {};
      const result = scorePrice(body);
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: "Unknown op. Use GET ?op=engine-status or POST with {context, campaign}." });
  } catch (err) {
    console.error("[Benna API Error]", err);
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
};

// Expose the core inference so other services (MCP, internal tools)
// can call Benna directly without a second HTTP hop.
module.exports.scoreBid = scoreBid;
module.exports.scorePrice = scorePrice;
module.exports.engineStatus = engineStatus;
module.exports.MODEL_VERSION = MODEL_VERSION;
// Internal helpers — exported for unit tests and for callers that want
// to compute one factor in isolation.
module.exports._intentMatchScore = intentMatchScore;
module.exports._cosineSimilarity = cosineSimilarity;
module.exports._geoMultiplier = geoMultiplier;
module.exports._formatMultiplier = formatMultiplier;
module.exports._safetyMultiplier = safetyMultiplier;
