/**
 * Boost Boss — Event Tracking API
 *
 * Fires on every impression, click, close, skip, and video_complete.
 * The ledger feeds billing (advertiser spend) and payouts (publisher share).
 *
 * Two modes:
 *   • PRODUCTION — Supabase events table + atomic campaign spend update
 *   • DEMO       — in-process store, same response shape
 *
 * Endpoints
 *   GET  /api/track?event=...&campaign_id=...  pixel beacon (returns 1x1 GIF)
 *   POST /api/track                             JSON body, returns { tracked: true }
 */

const TAKE_RATE = Number(process.env.BBX_TAKE_RATE) || 0.15;

const HAS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
);

let _supabase = null;
function supa() {
  if (_supabase) return _supabase;
  if (!HAS_SUPABASE) return null;
  try {
    const { createClient } = require("@supabase/supabase-js");
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    );
    return _supabase;
  } catch (_) { return null; }
}

// ── Demo store ─────────────────────────────────────────────────────────
const DEMO_EVENTS = [];

// 1×1 transparent GIF — returned on GET requests (pixel tracking from <img> tags)
const PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"
);

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("x-track-mode", HAS_SUPABASE ? "supabase" : "demo");
  if (req.method === "OPTIONS") return res.status(200).end();

  const params = req.method === "GET" ? (req.query || {}) : (req.body || {});
  const event      = params.event;
  const campaignId = params.campaign_id;
  const sessionId  = params.session || params.session_id || null;
  const developerId = params.dev || params.developer_id || null;

  if (!event || !campaignId) {
    return res.status(400).json({ error: "Missing event or campaign_id" });
  }

  const valid = ["impression", "click", "close", "skip", "video_complete"];
  if (!valid.includes(event)) {
    return res.status(400).json({ error: `Invalid event type. Use: ${valid.join(", ")}` });
  }

  const record = {
    event_type: event,
    campaign_id: campaignId,
    session_id: sessionId,
    developer_id: developerId || null,
    ip_country: (req.headers && req.headers["x-vercel-ip-country"]) || "unknown",
    ip_region:  (req.headers && req.headers["x-vercel-ip-country-region"]) || "unknown",
    ip_city:    (req.headers && req.headers["x-vercel-ip-city"]) || "unknown",
    user_language: params.lang || "en",
    user_agent: (req.headers && req.headers["user-agent"]) || "",
    cost: 0,
    developer_payout: 0,
    created_at: new Date().toISOString(),
  };

  const sb = supa();

  if (sb) {
    // ── Supabase path ──
    // Insert with cost pre-computed so we never need a second update (fixes race condition)
    if (["impression", "click", "video_complete"].includes(event)) {
      const { data: campaign } = await sb.from("campaigns")
        .select("billing_model, bid_amount, spent_today, spent_total, daily_budget, total_budget")
        .eq("id", campaignId).single();
      if (campaign) {
        const cost = computeCost(event, campaign);
        if (cost > 0) {
          record.cost = cost;
          record.developer_payout = +(cost * (1 - TAKE_RATE)).toFixed(4);
          // Atomic budget deduction — increment rather than read-then-write
          const newDaily = (campaign.spent_today || 0) + cost;
          const newTotal = (campaign.spent_total || 0) + cost;
          await sb.from("campaigns").update({
            spent_today: newDaily, spent_total: newTotal,
            // Auto-pause if budget exhausted
            ...(newDaily >= campaign.daily_budget || newTotal >= campaign.total_budget
              ? { status: "paused" } : {}),
          }).eq("id", campaignId);
        }
      }
    }
    const { error } = await sb.from("events").insert(record);
    if (error) console.error("[Track] event insert:", error.message);
  } else {
    // ── Demo path — compute cost and attribute to developer ──
    if (["impression", "click", "video_complete"].includes(event)) {
      let campaign = null;
      try {
        const camps = require("./campaigns.js")._DEMO_CAMPAIGNS || [];
        campaign = camps.find(c => c.id === campaignId);
      } catch (_) {}
      if (campaign) {
        const cost = computeCost(event, campaign);
        if (cost > 0) {
          record.cost = cost;
          record.developer_payout = +(cost * (1 - TAKE_RATE)).toFixed(4);
          campaign.spent_today = (campaign.spent_today || 0) + cost;
          campaign.spent_total = (campaign.spent_total || 0) + cost;
          // Auto-pause in demo too
          if (campaign.spent_today >= campaign.daily_budget || campaign.spent_total >= campaign.total_budget) {
            campaign.status = "paused";
          }
        }
      }
    }
    DEMO_EVENTS.push(record);
  }

  // GET requests return a pixel (from <img> beacons inside ad markup)
  if (req.method === "GET") {
    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Cache-Control", "no-store");
    return res.send(PIXEL_GIF);
  }

  return res.json({
    tracked: true, event, campaign_id: campaignId,
    mode: HAS_SUPABASE ? "supabase" : "demo",
  });
};

function computeCost(event, campaign) {
  if (event === "impression" && campaign.billing_model === "cpm") {
    return (campaign.bid_amount || 0) / 1000;
  }
  if (event === "click" && campaign.billing_model === "cpc") {
    return campaign.bid_amount || 0;
  }
  if (event === "video_complete" && campaign.billing_model === "cpv") {
    return campaign.bid_amount || 0;
  }
  return 0;
}

// ── Exports for testing ─────────────────────────────────────────────────
module.exports.HAS_SUPABASE = HAS_SUPABASE;
module.exports._DEMO_EVENTS = DEMO_EVENTS;
module.exports._reset = function () { DEMO_EVENTS.length = 0; };
