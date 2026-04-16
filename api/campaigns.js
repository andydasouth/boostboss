/**
 * Boost Boss — SuperBoost Campaigns API
 *
 * Two execution modes (same as auth.js, billing.js, rtb.js):
 *   • PRODUCTION — Supabase
 *   • DEMO       — in-process store seeded with sample campaigns
 *
 * Endpoints
 *   GET    /api/campaigns?advertiser_id=xxx          list campaigns
 *   GET    /api/campaigns?id=xxx                     get single campaign
 *   POST   /api/campaigns?action=create              create campaign (status=in_review)
 *   PATCH  /api/campaigns?action=update              update campaign fields
 *   POST   /api/campaigns?action=review              approve or reject (admin)
 *   POST   /api/campaigns?action=upload_creative     validate creative URL + metadata
 *   GET    /api/campaigns?action=review_queue         list campaigns pending review
 *
 * Creative review flow
 *   1. Advertiser creates campaign → status = in_review
 *   2. Creative URL is validated (reachable, right content-type, size limits)
 *   3. Policy check: adomain not on blocklist, iab_cat not restricted
 *   4. Admin approves → status = active (or rejects with reason)
 *   5. Only active campaigns enter the RTB auction
 */

const crypto = require("crypto");
const { verifyJwt } = require("./auth.js");

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

// ── Demo in-process campaign store ─────────────────────────────────────
const DEMO_CAMPAIGNS = new Map();
let _seeded = false;
let _lastResetDay = new Date().toISOString().slice(0, 10);

// Reset spent_today on all demo campaigns when the date changes (mimics pg_cron).
function checkDailyReset() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _lastResetDay) {
    _lastResetDay = today;
    for (const c of DEMO_CAMPAIGNS.values()) {
      c.spent_today = 0;
      // Un-pause campaigns that were auto-paused due to daily budget exhaustion
      // (but not manually paused or rejected campaigns)
      if (c.status === "paused" && (c._auto_paused || false)) {
        c.status = "active";
        c._auto_paused = false;
      }
    }
  }
}

function seedDemoCampaigns() {
  if (_seeded) return;
  _seeded = true;
  const seeds = [
    {
      id: "cam_cursor_001", advertiser_id: "adv_cursor", name: "Cursor AI IDE",
      status: "active", format: "native",
      headline: "Ship a FastAPI app in 90 seconds",
      subtext: "Deploy with one command. Free tier included.",
      media_url: "https://cdn.boostboss.ai/cr/cursor-001.png",
      cta_label: "Try the free tier", cta_url: "https://example-advertiser.com/?ref=bb",
      adomain: ["example-advertiser.com"], iab_cat: ["IAB19-6"],
      target_keywords: ["python", "fastapi", "deploy"],
      target_regions: ["us-west", "us-east", "global"], target_languages: ["en"],
      daily_budget: 500, total_budget: 20000, spent_today: 112.40, spent_total: 3401.25,
      target_cpa: 8.0, bid_amount: 9.25, billing_model: "cpm",
      created_at: "2026-03-01T00:00:00Z", updated_at: "2026-04-15T00:00:00Z",
    },
    {
      id: "cam_datadog_001", advertiser_id: "adv_dd", name: "Datadog APM",
      status: "active", format: "native",
      headline: "Trace a production error in 30 seconds",
      subtext: "Real-time logs, metrics, and traces — unified.",
      media_url: "https://cdn.boostboss.ai/cr/dd-001.png",
      cta_label: "Start free trial", cta_url: "https://example-dsp.com/?ref=bb",
      adomain: ["example-dsp.com"], iab_cat: ["IAB19-11"],
      target_keywords: ["debug", "error", "trace", "logs", "monitoring"],
      target_regions: ["global"], target_languages: ["en"],
      daily_budget: 1200, total_budget: 80000, spent_today: 340.00, spent_total: 11200.00,
      target_cpa: 12.0, bid_amount: 13.50, billing_model: "cpm",
      created_at: "2026-02-15T00:00:00Z", updated_at: "2026-04-15T00:00:00Z",
    },
    {
      id: "cam_railway_001", advertiser_id: "adv_rw", name: "Railway Deploy",
      status: "active", format: "native",
      headline: "Deploy in one command",
      subtext: "Python, Node, Go, Elixir. Git-push to prod.",
      media_url: "https://cdn.boostboss.ai/cr/rw-001.png",
      cta_label: "Deploy now", cta_url: "https://example-deploy.com/?ref=bb",
      adomain: ["example-deploy.com"], iab_cat: ["IAB19-30"],
      target_keywords: ["deploy", "hosting", "infrastructure"],
      target_regions: ["us-west", "eu-central"], target_languages: ["en"],
      daily_budget: 300, total_budget: 12000, spent_today: 18.00, spent_total: 860.00,
      target_cpa: 6.0, bid_amount: 6.80, billing_model: "cpm",
      created_at: "2026-03-10T00:00:00Z", updated_at: "2026-04-15T00:00:00Z",
    },
    {
      id: "cam_pending_001", advertiser_id: "adv_cursor", name: "Cursor Pro Launch",
      status: "in_review", format: "native",
      headline: "Cursor Pro — AI code review for teams",
      subtext: "Ship safer code. AI-powered PR reviews.",
      media_url: "https://cdn.boostboss.ai/cr/cursor-pro-001.png",
      cta_label: "Get early access", cta_url: "https://example-advertiser.com/pro?ref=bb",
      adomain: ["example-advertiser.com"], iab_cat: ["IAB19-6"],
      target_keywords: ["code review", "team", "enterprise"],
      target_regions: ["global"], target_languages: ["en"],
      daily_budget: 800, total_budget: 50000, spent_today: 0, spent_total: 0,
      target_cpa: 15.0, bid_amount: 16.00, billing_model: "cpm",
      review_notes: null, reviewed_at: null, reviewed_by: null,
      created_at: "2026-04-15T00:00:00Z", updated_at: "2026-04-15T00:00:00Z",
    },
  ];
  for (const s of seeds) DEMO_CAMPAIGNS.set(s.id, s);
}

// ── Creative policy validation ─────────────────────────────────────────
const BLOCKED_CATEGORIES = new Set([
  "IAB7-39",  // extreme graphic violence
  "IAB25-3",  // illegal drugs
  "IAB25-2",  // discrimination
  "IAB26-1",  // adult content
  "IAB26-2",  // adult content
  "IAB26-3",  // adult content
  "IAB26-4",  // adult content
]);

const BLOCKED_ADOMAINS = new Set([
  // placeholder — in production this is loaded from a DB table or remote list
]);

function validateCreativePolicy(campaign) {
  const issues = [];

  // Category check
  for (const cat of (campaign.iab_cat || [])) {
    if (BLOCKED_CATEGORIES.has(cat)) issues.push(`Blocked IAB category: ${cat}`);
  }
  // Domain check
  for (const d of (campaign.adomain || [])) {
    if (BLOCKED_ADOMAINS.has(d)) issues.push(`Blocked advertiser domain: ${d}`);
  }
  // Headline length
  if (campaign.headline && campaign.headline.length > 90) {
    issues.push("Headline exceeds 90 characters");
  }
  // Subtext length
  if (campaign.subtext && campaign.subtext.length > 300) {
    issues.push("Subtext exceeds 300 characters");
  }
  // CTA URL must be HTTPS
  if (campaign.cta_url && !campaign.cta_url.startsWith("https://")) {
    issues.push("CTA URL must use HTTPS");
  }
  // Media URL must be present for non-native
  if (campaign.format !== "native" && !campaign.media_url) {
    issues.push("media_url is required for image/video formats");
  }
  // Budget sanity
  if ((campaign.daily_budget || 0) <= 0) issues.push("daily_budget must be > 0");
  if ((campaign.total_budget || 0) <= 0) issues.push("total_budget must be > 0");
  if ((campaign.daily_budget || 0) > (campaign.total_budget || 0)) {
    issues.push("daily_budget cannot exceed total_budget");
  }

  return { ok: issues.length === 0, issues };
}

// ── Admin auth helper ──────────────────────────────────────────────────
// Verifies the caller has a valid JWT with role = "admin".
// In demo mode, also accepts role = "advertiser" acting as admin
// (so the admin.html page works without a separate admin account).
function requireAdmin(req) {
  const authHeader = req.headers && req.headers.authorization;
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const claims = verifyJwt(token);
  if (!claims) return null;
  // Production: only admin role. Demo: admin OR advertiser (admin.html logs in as advertiser).
  if (claims.role === "admin") return claims;
  if (!HAS_SUPABASE && (claims.role === "advertiser" || claims.role === "developer")) return claims;
  return null;
}

// ────────────────────────────────────────────────────────────────────────
//                                HANDLER
// ────────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("x-campaigns-mode", HAS_SUPABASE ? "supabase" : "demo");
  if (req.method === "OPTIONS") return res.status(200).end();

  seedDemoCampaigns();
  if (!HAS_SUPABASE) checkDailyReset();

  const action = (req.query && req.query.action) || (req.body && req.body.action);

  try {
    // ── List campaigns ──
    if (req.method === "GET" && !action) {
      return await handleList(req, res);
    }
    if (req.method === "GET" && action === "review_queue") {
      if (!requireAdmin(req)) return res.status(401).json({ error: "Admin authentication required" });
      return await handleReviewQueue(req, res);
    }
    // Single campaign by id
    if (req.method === "GET" && action === "get") {
      return await handleGet(req, res);
    }

    if (req.method === "POST" && action === "create") {
      return await handleCreate(req, res);
    }
    if (req.method === "POST" && action === "review") {
      if (!requireAdmin(req)) return res.status(401).json({ error: "Admin authentication required" });
      return await handleReview(req, res);
    }
    if (req.method === "POST" && action === "pause") {
      return await handlePauseResume(req, res, "paused");
    }
    if (req.method === "POST" && action === "resume") {
      return await handlePauseResume(req, res, "active");
    }
    if (req.method === "POST" && action === "upload_creative") {
      return await handleUploadCreative(req, res);
    }
    if ((req.method === "PATCH" || req.method === "POST") && action === "update") {
      return await handleUpdate(req, res);
    }

    // Legacy compat: bare GET with advertiser_id
    if (req.method === "GET") return await handleList(req, res);
    // Legacy compat: bare POST = create
    if (req.method === "POST") return await handleCreate(req, res);

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[Campaigns Error]", err);
    return res.status(500).json({ error: err.message });
  }
};

// ── list ────────────────────────────────────────────────────────────────
async function handleList(req, res) {
  const { advertiser_id, status: filterStatus } = req.query;
  const sb = supa();
  if (sb) {
    let q = sb.from("campaigns").select("*").order("created_at", { ascending: false });
    if (advertiser_id) q = q.eq("advertiser_id", advertiser_id);
    if (filterStatus) q = q.eq("status", filterStatus);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ campaigns: data });
  }
  let camps = [...DEMO_CAMPAIGNS.values()];
  if (advertiser_id) camps = camps.filter((c) => c.advertiser_id === advertiser_id);
  if (filterStatus) camps = camps.filter((c) => c.status === filterStatus);
  camps.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return res.json({ campaigns: camps });
}

// ── get single ──────────────────────────────────────────────────────────
async function handleGet(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Missing campaign id" });
  const sb = supa();
  if (sb) {
    const { data, error } = await sb.from("campaigns").select("*").eq("id", id).single();
    if (error || !data) return res.status(404).json({ error: "Campaign not found" });
    return res.json({ campaign: data });
  }
  const c = DEMO_CAMPAIGNS.get(id);
  if (!c) return res.status(404).json({ error: "Campaign not found" });
  return res.json({ campaign: c });
}

// ── create ──────────────────────────────────────────────────────────────
async function handleCreate(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const b = req.body || {};
  if (!b.advertiser_id || !b.headline || !b.cta_url) {
    return res.status(400).json({ error: "Missing required fields: advertiser_id, headline, cta_url" });
  }
  // Image and video formats require a media_url
  if (["image", "video"].includes(b.format) && !b.media_url) {
    return res.status(400).json({ error: `media_url is required for ${b.format} format campaigns` });
  }

  // Validate numeric bounds on financial fields
  const bidAmount = Number(b.bid_amount || 5);
  const dailyBudget = Number(b.daily_budget || 50);
  const totalBudget = Number(b.total_budget || 1000);
  if (!Number.isFinite(bidAmount) || bidAmount < 0.01 || bidAmount > 1000) {
    return res.status(400).json({ error: "bid_amount must be between $0.01 and $1,000" });
  }
  if (!Number.isFinite(dailyBudget) || dailyBudget < 1 || dailyBudget > 1000000) {
    return res.status(400).json({ error: "daily_budget must be between $1 and $1,000,000" });
  }
  if (!Number.isFinite(totalBudget) || totalBudget < 1 || totalBudget > 10000000) {
    return res.status(400).json({ error: "total_budget must be between $1 and $10,000,000" });
  }

  const now = new Date().toISOString();
  const row = {
    id: b.id || "cam_" + crypto.randomBytes(6).toString("hex"),
    advertiser_id: b.advertiser_id,
    name: b.name || b.headline.slice(0, 40),
    status: "in_review", // always starts in review
    format: b.format || "native",
    headline: b.headline,
    subtext: b.subtext || "",
    media_url: b.media_url || "",
    poster_url: b.poster_url || null,
    cta_label: b.cta_label || "Learn More",
    cta_url: b.cta_url,
    adomain: b.adomain || [],
    iab_cat: b.iab_cat || [],
    target_keywords: b.target_keywords || [],
    target_regions: b.target_regions || ["global"],
    target_languages: b.target_languages || ["en"],
    target_cpa: b.target_cpa || null,
    target_roas: b.target_roas || null,
    optimization_goal: b.optimization_goal || "target_cpa",
    billing_model: b.billing_model || "cpm",
    bid_amount: b.bid_amount || 5.00,
    daily_budget: b.daily_budget || 50.00,
    total_budget: b.total_budget || 1000.00,
    start_date: b.start_date || null,
    end_date: b.end_date || null,
    skippable_after_sec: b.skippable_after_sec || 3,
    spent_today: 0, spent_total: 0,
    created_at: now, updated_at: now,
  };

  // Run creative policy check immediately
  const policy = validateCreativePolicy(row);

  const sb = supa();
  if (sb) {
    const { data, error } = await sb.from("campaigns").insert(row).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ campaign: data, policy });
  }
  DEMO_CAMPAIGNS.set(row.id, row);
  return res.status(201).json({ campaign: row, policy });
}

// ── update ──────────────────────────────────────────────────────────────
async function handleUpdate(req, res) {
  const b = req.body || {};
  if (!b.id) return res.status(400).json({ error: "Missing campaign id" });

  const allowed = [
    "name", "headline", "subtext", "media_url", "poster_url",
    "cta_label", "cta_url", "adomain", "iab_cat", "format",
    "target_keywords", "target_regions", "target_languages",
    "target_cpa", "billing_model", "bid_amount",
    "daily_budget", "total_budget", "status", "skippable_after_sec",
    "start_date", "end_date", "optimization_goal", "target_roas",
  ];
  const updates = {};
  for (const k of allowed) if (b[k] !== undefined) updates[k] = b[k];
  updates.updated_at = new Date().toISOString();

  const sb = supa();
  if (sb) {
    const { data, error } = await sb.from("campaigns").update(updates).eq("id", b.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ campaign: data });
  }
  const c = DEMO_CAMPAIGNS.get(b.id);
  if (!c) return res.status(404).json({ error: "Campaign not found" });
  Object.assign(c, updates);
  return res.json({ campaign: c });
}

// ── pause / resume ─────────────────────────────────────────────────────
// POST /api/campaigns?action=pause  { id }
// POST /api/campaigns?action=resume { id }
async function handlePauseResume(req, res, targetStatus) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "Missing campaign id" });

  const validFrom = targetStatus === "paused" ? ["active"] : ["paused"];
  const now = new Date().toISOString();

  const sb = supa();
  if (sb) {
    const { data, error } = await sb.from("campaigns")
      .update({ status: targetStatus, updated_at: now })
      .eq("id", id)
      .in("status", validFrom)
      .select().single();
    if (error || !data) {
      return res.status(400).json({ error: `Campaign not found or cannot ${targetStatus === "paused" ? "pause" : "resume"} from current status` });
    }
    return res.json({ campaign: data, action: targetStatus === "paused" ? "paused" : "resumed" });
  }

  const c = DEMO_CAMPAIGNS.get(id);
  if (!c) return res.status(404).json({ error: "Campaign not found" });
  if (!validFrom.includes(c.status)) {
    return res.status(400).json({ error: `Cannot ${targetStatus === "paused" ? "pause" : "resume"} campaign with status '${c.status}'` });
  }
  c.status = targetStatus;
  c.updated_at = now;
  return res.json({ campaign: c, action: targetStatus === "paused" ? "paused" : "resumed" });
}

// ── review (approve / reject) ───────────────────────────────────────────
async function handleReview(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { id, decision, notes } = req.body || {};
  if (!id) return res.status(400).json({ error: "Missing campaign id" });
  if (!decision || !["approve", "reject"].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
  }

  const newStatus = decision === "approve" ? "active" : "rejected";
  const now = new Date().toISOString();

  const sb = supa();
  if (sb) {
    const { data, error } = await sb.from("campaigns")
      .update({ status: newStatus, review_notes: notes || null, reviewed_at: now, updated_at: now })
      .eq("id", id)
      .eq("status", "in_review") // can only review campaigns that are pending
      .select().single();
    if (error || !data) return res.status(400).json({ error: "Campaign not found or not in_review" });
    return res.json({ campaign: data, decision });
  }
  const c = DEMO_CAMPAIGNS.get(id);
  if (!c) return res.status(404).json({ error: "Campaign not found" });
  if (c.status !== "in_review") return res.status(400).json({ error: "Campaign is not in_review" });
  c.status = newStatus;
  c.review_notes = notes || null;
  c.reviewed_at = now;
  c.updated_at = now;
  return res.json({ campaign: c, decision });
}

// ── review queue ────────────────────────────────────────────────────────
async function handleReviewQueue(req, res) {
  const sb = supa();
  if (sb) {
    const { data, error } = await sb.from("campaigns")
      .select("*").eq("status", "in_review").order("created_at");
    if (error) return res.status(500).json({ error: error.message });
    // Run policy check on each
    const enriched = (data || []).map((c) => ({ ...c, policy: validateCreativePolicy(c) }));
    return res.json({ queue: enriched, count: enriched.length });
  }
  const queue = [...DEMO_CAMPAIGNS.values()]
    .filter((c) => c.status === "in_review")
    .map((c) => ({ ...c, policy: validateCreativePolicy(c) }));
  return res.json({ queue, count: queue.length });
}

// ── creative upload validation ──────────────────────────────────────────
// In v1 this just validates the URL is reachable + content-type. Future:
// accept multipart upload → S3 → CloudFront CDN URL back.
async function handleUploadCreative(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { media_url, format } = req.body || {};
  if (!media_url) return res.status(400).json({ error: "Missing media_url" });

  // URL format check
  try { new URL(media_url); }
  catch (_) { return res.status(400).json({ error: "Invalid URL format" }); }

  if (!media_url.startsWith("https://")) {
    return res.status(400).json({ error: "media_url must use HTTPS" });
  }

  // Content-type validation (we just validate the URL format + expected types)
  const ext = media_url.split("?")[0].split(".").pop().toLowerCase();
  const validImage = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
  const validVideo = ["mp4", "webm", "mov"];

  let type = "unknown";
  if (validImage.includes(ext)) type = "image";
  else if (validVideo.includes(ext)) type = "video";

  if (format === "image" && type !== "image") {
    return res.status(400).json({ error: `Expected image file, got .${ext}` });
  }
  if (format === "video" && type !== "video") {
    return res.status(400).json({ error: `Expected video file, got .${ext}` });
  }

  return res.json({
    valid: true,
    media_url,
    detected_type: type,
    message: "Creative URL validated. Attach to campaign via create or update.",
  });
}

// ── Exports for testing ─────────────────────────────────────────────────
module.exports.validateCreativePolicy = validateCreativePolicy;
module.exports.HAS_SUPABASE = HAS_SUPABASE;
module.exports._DEMO_CAMPAIGNS = DEMO_CAMPAIGNS;
module.exports._reset = function () { DEMO_CAMPAIGNS.clear(); _seeded = false; };
module.exports._seed = seedDemoCampaigns;
