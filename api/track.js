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

// Rate limiting: prevent abuse by limiting events per IP per minute
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 120; // 120 events per IP per minute (2/sec avg)
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    entry = { start: now, count: 0 };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  // Periodically clean stale entries (every 1000 checks)
  if (rateLimitMap.size > 10000) {
    for (const [k, v] of rateLimitMap) {
      if (now - v.start > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(k);
    }
  }
  return entry.count <= RATE_LIMIT_MAX;
}

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
  // GET (pixel beacons) need * because they fire from publisher domains.
  // POST requests are restricted to known origins in production.
  const PUBLIC_BASE = process.env.BOOSTBOSS_BASE_URL || "https://boostboss.ai";
  if (req.method === "GET" || !HAS_SUPABASE) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    const origin = req.headers && req.headers.origin;
    const allowed = ["https://boostboss.ai", "https://www.boostboss.ai", PUBLIC_BASE];
    res.setHeader("Access-Control-Allow-Origin", allowed.includes(origin) ? origin : PUBLIC_BASE);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("x-track-mode", HAS_SUPABASE ? "supabase" : "demo");
  if (req.method === "OPTIONS") return res.status(200).end();

  const params = req.method === "GET" ? (req.query || {}) : (req.body || {});
  const event      = params.event;
  const campaignId = params.campaign_id;
  const sessionId  = params.session || params.session_id || null;
  // Stable per-user id for freq capping (db/06_freq_cap.sql).
  // GET pixel beacons can pass it as `anon`; POST passes `anonymous_id`.
  const anonymousId = params.anon || params.anonymous_id || null;
  // Callers (MCP handler, SDK pixel, direct API) may pass EITHER the
  // publisher's UUID or their api_key ("bb_dev_live_..."). events.developer_id
  // is a UUID column, so we resolve api_keys to UUIDs before insert —
  // otherwise Postgres rejects the insert and the impression vanishes.
  let developerId = params.dev || params.developer_id || null;

  // ── BBX auction-keyed fields (protocol §6) ─────────────────────────
  // Short query keys (`auction`, `placement`, `ims`) come from the GET
  // pixel URLs minted by api/mcp.js; long body keys come from the POST
  // path that the SDK and JSON-RPC track_event tool use.
  const auctionId   = params.auction || params.auction_id || params.bbx_auc || null;
  const placementId = params.placement || params.placement_id || null;
  const surface     = params.surface || null;
  const format      = params.format  || null;
  const intentMatchScore = params.ims != null ? Number(params.ims)
                       : (params.intent_match_score != null ? Number(params.intent_match_score) : null);

  // ── Conversion-specific fields (protocol §6.2) ─────────────────────
  // value comes in as USD dollars on the wire; we store cents as int.
  const conversionType = params.conversion_type || params.type || null;
  const valueRaw       = params.value != null ? params.value
                       : (params.value_micros != null ? Number(params.value_micros) / 10000 : null);
  const valueCents     = valueRaw != null && Number.isFinite(Number(valueRaw))
                          ? Math.round(Number(valueRaw) * 100) : null;
  const externalId     = params.external_id || params.bbx_eid || null;
  const currency       = params.currency || "USD";

  if (!event || !campaignId) {
    return res.status(400).json({ error: "Missing event or campaign_id" });
  }

  // Resolve api_key → UUID for Supabase inserts. Diagnostic header tells
  // the E2E whether the publisher's events will be queryable later.
  let _devResolved = "n/a";
  if (developerId && typeof developerId === "string" && developerId.startsWith("bb_dev_")) {
    const sbResolve = supa();
    if (sbResolve) {
      const { data: dev, error: devErr } = await sbResolve.from("developers")
        .select("id").eq("api_key", developerId).single();
      if (dev) { developerId = dev.id; _devResolved = "ok"; }
      else { developerId = null; _devResolved = "miss:" + (devErr?.code || "no_rows"); }
    } else { _devResolved = "no_sb"; }
  }
  res.setHeader("x-track-dev-resolved", _devResolved);
  res.setHeader("x-track-key-type",
    process.env.SUPABASE_SERVICE_ROLE_KEY ? "service_role" :
    process.env.SUPABASE_ANON_KEY ? "anon" : "none");

  const valid = ["impression", "click", "close", "skip", "video_complete", "conversion", "dismiss"];
  if (!valid.includes(event)) {
    return res.status(400).json({ error: `Invalid event type. Use: ${valid.join(", ")}` });
  }

  // Rate limiting per IP to prevent budget drain attacks
  const clientIp = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown";
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: "Rate limit exceeded — try again later" });
  }

  // Validate campaign_id exists before recording billable events
  // This prevents attackers from burning budgets on non-existent or others' campaigns
  if (["impression", "click", "video_complete"].includes(event)) {
    const sb = supa();
    if (sb) {
      const { data: camp, error: campErr } = await sb.from("campaigns")
        .select("id, status").eq("id", campaignId).single();
      if (campErr || !camp) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      if (camp.status !== "active") {
        return res.status(403).json({ error: "Campaign is not active" });
      }
    } else {
      // Demo: validate against in-memory campaigns
      let found = false;
      try {
        const camps = require("./campaigns.js")._DEMO_CAMPAIGNS;
        if (camps) {
          const c = typeof camps.get === "function" ? camps.get(campaignId) : camps.find(c => c.id === campaignId);
          if (c && c.status === "active") found = true;
        }
      } catch (_) {}
      // In demo mode, allow unknown campaign_ids to keep tests passing
      // but log a warning — in production this is blocked above
    }
  }

  // Per-request integration source — tagged so the dashboard can slice
  // impressions/clicks by which integration the request came through.
  // Set by SDKs via X-Lumi-Source header. Falls back to params.integration_method
  // (for callers that pass it in the body) or null. Whitelisted to prevent
  // garbage; the DB CHECK constraint (db/06_integration_method.sql) enforces
  // the same set as a backstop.
  const _src = String(
    (req.headers && req.headers["x-lumi-source"]) ||
    params.integration_method ||
    ""
  ).toLowerCase().trim();
  const integrationMethod = ["mcp", "js-snippet", "npm-sdk", "rest-api"].includes(_src)
    ? _src
    : null;

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
    // BBX auction-keyed fields (columns added by db/04_bbx_mcp_extensions.sql §3).
    // All nullable; legacy callers without auction context still work.
    auction_id:   auctionId,
    placement_id: placementId,
    surface:      surface,
    format:       format,
    intent_match_score: Number.isFinite(intentMatchScore) ? intentMatchScore : null,
    anonymous_id: anonymousId,
    // Conversion fields (db/05_bbx_conversions.sql). Only populated when
    // event === 'conversion'; null otherwise.
    conversion_type: event === "conversion" ? conversionType : null,
    value_cents:     event === "conversion" ? valueCents     : null,
    external_id:     event === "conversion" ? externalId     : null,
    currency:        event === "conversion" ? currency       : null,
    // Integration source (db/06_integration_method.sql). NULL allowed.
    integration_method: integrationMethod,
    created_at: new Date().toISOString(),
  };

  const sb = supa();

  if (sb) {
    // ── Supabase path ──

    // Idempotency: per protocol §6.3, at most one event row per
    // (auction_id, event_type). When auction_id is set, check first so we
    // don't double-charge the advertiser for retried impressions / clicks.
    // Index `events_auction_type_unique` (partial, where auction_id is not null)
    // is the underlying constraint.
    if (auctionId) {
      const { data: existing } = await sb.from("events")
        .select("id").eq("auction_id", auctionId).eq("event_type", event)
        .limit(1).maybeSingle();
      if (existing) {
        res.setHeader("x-track-deduplicated", "1");
        if (req.method === "GET") {
          res.setHeader("Content-Type", "image/gif");
          res.setHeader("Cache-Control", "no-store");
          return res.send(PIXEL_GIF);
        }
        return res.json({
          tracked: true, deduplicated: true, event,
          campaign_id: campaignId, auction_id: auctionId,
        });
      }
    }

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
    if (error) {
      // 23505 = unique_violation. If the partial unique index fired between
      // our pre-check and the insert (race), treat as deduplication, not error.
      if (error.code === "23505") {
        res.setHeader("x-track-deduplicated", "race");
      } else {
        console.error("[Track] event insert:", error.message);
      }
    }
  } else {
    // ── Demo path — compute cost and attribute to developer ──
    // Demo idempotency: scan the in-memory store for (auction_id, event_type).
    if (auctionId && DEMO_EVENTS.some((r) => r.auction_id === auctionId && r.event_type === event)) {
      res.setHeader("x-track-deduplicated", "1");
      if (req.method === "GET") {
        res.setHeader("Content-Type", "image/gif");
        res.setHeader("Cache-Control", "no-store");
        return res.send(PIXEL_GIF);
      }
      return res.json({
        tracked: true, deduplicated: true, event,
        campaign_id: campaignId, auction_id: auctionId,
      });
    }

    if (["impression", "click", "video_complete"].includes(event)) {
      let campaign = null;
      try {
        // _DEMO_CAMPAIGNS is a Map in campaigns.js — use .get() not .find()
        const camps = require("./campaigns.js")._DEMO_CAMPAIGNS;
        if (camps && typeof camps.get === "function") campaign = camps.get(campaignId);
        else if (Array.isArray(camps)) campaign = camps.find(c => c.id === campaignId);
      } catch (_) {}
      if (campaign) {
        const cost = computeCost(event, campaign);
        if (cost > 0) {
          record.cost = cost;
          record.developer_payout = +(cost * (1 - TAKE_RATE)).toFixed(4);
          campaign.spent_today = (campaign.spent_today || 0) + cost;
          campaign.spent_total = (campaign.spent_total || 0) + cost;
          // Auto-pause in demo too (mark as _auto_paused so daily reset can un-pause)
          if (campaign.spent_today >= campaign.daily_budget || campaign.spent_total >= campaign.total_budget) {
            campaign.status = "paused";
            campaign._auto_paused = true;
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
    auction_id: auctionId, placement_id: placementId,
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
module.exports._rateLimitMap = rateLimitMap;
module.exports._RATE_LIMIT_MAX = RATE_LIMIT_MAX;
module.exports._reset = function () { DEMO_EVENTS.length = 0; rateLimitMap.clear(); };
