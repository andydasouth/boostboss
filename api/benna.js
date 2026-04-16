/**
 * Boost Boss — Benna Inference API (stub)
 *
 *   GET  /api/benna?op=engine-status&advertiser_id=xxx
 *        → aggregate engine metrics, top weighted signals, recent auto-adjustments
 *
 *   POST /api/benna                 (op=predict)
 *        body: { context: { intent, mcp_tool, host, session_len, region, ... },
 *                campaign: { target_cpa, target_roas, goal, format } }
 *        → { bid, p_click, p_convert, signal_contributions[], latency_ms, model_version }
 *
 * This is a deterministic stub that simulates the real Benna ranker so the
 * product feels end-to-end without requiring the actual ML infra. Swap out
 * the `scoreBid()` body for the real model once it ships.
 */

const MODEL_VERSION = "benna-rc3-2026.04.14";

// Signal priors (weights sum to ~1.0). These are what the engine "has learned"
// as the most predictive MCP signals for conversion across the network.
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

// ─── core inference stub ───
function scoreBid(context = {}, campaign = {}) {
  const rnd = seeded(
    hash(JSON.stringify(context) + (campaign.target_cpa || "") + currentBucketSeed())
  );

  // base p_click ranges 0.4% – 7% depending on signals present
  let p_click = 0.01;
  const contributions = [];

  for (const [sig, prior] of Object.entries(SIGNAL_PRIORS)) {
    const [key, val] = sig.split("=");
    const hasSignal = matchesSignal(context, key, val);
    if (hasSignal) {
      const contribution = prior.w * (0.7 + rnd() * 0.6);
      p_click += contribution * 0.06;
      contributions.push({
        signal: sig,
        weight: +prior.w.toFixed(3),
        lift: +(contribution * 100).toFixed(1),
      });
    }
  }
  p_click = Math.min(p_click, 0.12);

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

function matchesSignal(ctx, key, expected) {
  const v = ctx[key];
  if (v == null) return false;
  if (key === "session_len") {
    // expected = ">30m"
    const mins = parseFloat(String(v));
    return Number.isFinite(mins) && mins > 30;
  }
  return String(v).toLowerCase() === String(expected).toLowerCase();
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
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

    // POST predict
    if (req.method === "POST") {
      const body = req.body || {};
      const context = body.context || {};
      const campaign = body.campaign || {};
      const result = scoreBid(context, campaign);
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
module.exports.engineStatus = engineStatus;
module.exports.MODEL_VERSION = MODEL_VERSION;
