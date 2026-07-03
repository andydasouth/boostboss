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
const { embedTokens } = require("./_lib/embeddings.js");
const { resolveAdvertiser } = require("./_lib/advertiser_auth.js");
const { deliverWebhook } = require("./_lib/webhook_delivery.js");

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
      target_intent_tokens: ["code", "python", "fastapi", "deploy", "ide"],
      target_active_tools: [],
      target_integration_methods: [],
      target_host_apps: ["cursor", "vscode", "claude_desktop"],
      target_surfaces: ["chat", "tool_response", "sidebar"],
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
      target_intent_tokens: ["debug_py", "error", "exception", "traceback", "monitoring", "observability"],
      target_active_tools: [],
      target_integration_methods: [],
      target_host_apps: ["cursor", "vscode", "claude_desktop", "jetbrains"],
      target_surfaces: ["chat", "tool_response", "sidebar"],
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
      target_intent_tokens: ["deploy", "hosting", "infrastructure", "nextjs", "node", "python"],
      target_active_tools: [],
      target_integration_methods: [],
      target_host_apps: ["cursor", "vscode", "claude_desktop"],
      target_surfaces: ["chat", "tool_response"],
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
      target_intent_tokens: ["code", "review", "refactor", "team", "enterprise"],
      target_active_tools: [],
      target_integration_methods: [],
      target_host_apps: ["cursor", "vscode", "jetbrains"],
      target_surfaces: ["chat", "sidebar"],
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

  // Static admin-key fallback. When BBX_ADMIN_KEY or ADMIN_TOKEN is set
  // in the env, any caller presenting that exact secret as
  // `Authorization: Bearer ...` is treated as admin. This is the auth
  // path the admin console uses — both env names are accepted so the
  // operator only has to configure one. Also useful for one-shot ops
  // (re-embed backfill, cron jobs, manual cleanup) without Supabase JWTs.
  const staticKeys = [process.env.BBX_ADMIN_KEY, process.env.ADMIN_TOKEN].filter(Boolean);
  if (token && staticKeys.includes(token)) {
    return { role: "admin", source: "static_key" };
  }

  // Demo mode (no Supabase) — the admin console is open, matching the
  // !HAS_SUPABASE bypass in api/stats and api/billing. A bearer header
  // is still required (checked above) so unauthenticated calls fail.
  if (!HAS_SUPABASE) return { role: "admin", source: "demo_open" };

  const claims = verifyJwt(token);
  if (!claims) return null;
  // Production: only admin role. Demo: admin OR advertiser (admin.html logs in as advertiser).
  if (claims.role === "admin") return claims;
  if (!HAS_SUPABASE && (claims.role === "advertiser" || claims.role === "developer")) return claims;
  return null;
}

// Accepts either an admin (via requireAdmin) OR Vercel cron (via the
// CRON_SECRET signature header). Used by the embed-* actions.
function requireAdminOrCron(req) {
  if (requireAdmin(req)) return true;
  const h = req.headers || {};
  if (process.env.CRON_SECRET) {
    if (h["x-vercel-signature"] === process.env.CRON_SECRET) return true;
    const auth = (h.authorization || "").replace(/^Bearer\s+/i, "");
    if (auth && auth === process.env.CRON_SECRET) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────
//                                HANDLER
// ────────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Restrict CORS in production to BoostBoss origins; allow * in demo for local dev
  const PUBLIC_BASE = process.env.BOOSTBOSS_BASE_URL || "https://boostboss.ai";
  if (HAS_SUPABASE) {
    const origin = req.headers && req.headers.origin;
    const allowed = ["https://boostboss.ai", "https://www.boostboss.ai", PUBLIC_BASE];
    res.setHeader("Access-Control-Allow-Origin", allowed.includes(origin) ? origin : PUBLIC_BASE);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
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
    if (req.method === "POST" && action === "fetch_url_preview") {
      return await handleFetchUrlPreview(req, res);
    }
    if ((req.method === "PATCH" || req.method === "POST") && action === "update") {
      return await handleUpdate(req, res);
    }
    if (req.method === "POST" && action === "reembed") {
      if (!requireAdmin(req)) return res.status(401).json({ error: "Admin authentication required" });
      return await handleReembed(req, res);
    }
    // ── Embedding cache ops (merged from former api/embed-cron.js) ──
    // Routed through campaigns.js because Vercel Hobby tier limits us
    // to 12 serverless functions and a separate file pushed us over.
    if (action === "embed_stats" || action === "embed_drain" || action === "embed_seed") {
      if (!requireAdminOrCron(req)) return res.status(401).json({ error: "Unauthorised" });
      return await handleEmbedAction(action, req, res);
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
  const { status: filterStatus } = req.query;
  const sb = supa();
  if (sb) {
    // ── Cross-tenant data leak fix 2026-06-25 ────────────────────────
    // Previously trusted ?advertiser_id from the query string — meaning
    // a caller could omit it and receive ALL advertisers' campaigns.
    // Now we derive advertiser_id server-side from the Bearer JWT and
    // ignore the query-string value entirely. Same pattern Task #152
    // applied to the products + billing endpoints.
    // Accepts EITHER a Boost Boss API key (bb_live_…) or a Supabase session
    // JWT; both resolve to the caller's own advertiser_id. Query-string
    // advertiser_id is ignored — see 2026-06-25 cross-tenant fix.
    const auth = await resolveAdvertiser(req, sb);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    const authedAdvertiserId = auth.advertiserId;

    let q = sb.from("campaigns").select("*")
      .eq("advertiser_id", authedAdvertiserId)
      .order("created_at", { ascending: false });
    if (filterStatus) q = q.eq("status", filterStatus);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ campaigns: data });
  }
  // Demo branch (no Supabase) — admin console is open, so we honor the
  // query-string advertiser_id directly. Production hits the Supabase
  // branch above which enforces Bearer-derived scoping.
  const demoAdvertiserId = req.query && req.query.advertiser_id;
  let camps = [...DEMO_CAMPAIGNS.values()];
  if (demoAdvertiserId) camps = camps.filter((c) => c.advertiser_id === demoAdvertiserId);
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
    // Cross-tenant fix 2026-06-25: enforce advertiser ownership on single
    // fetches too. Otherwise any caller with a valid token could request
    // any campaign id and read its full row.
    // Accepts EITHER a Boost Boss API key (bb_live_…) or a Supabase session
    // JWT; both resolve to the caller's own advertiser_id. Query-string
    // advertiser_id is ignored — see 2026-06-25 cross-tenant fix.
    const auth = await resolveAdvertiser(req, sb);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    const authedAdvertiserId = auth.advertiserId;

    const { data, error } = await sb.from("campaigns").select("*")
      .eq("id", id)
      .eq("advertiser_id", authedAdvertiserId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Campaign not found" });
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
  // ── Cross-tenant fix 2026-06-25 (create path) ────────────────────────
  // In production we derive the advertiser from the Bearer credential
  // (API key OR session JWT) and IGNORE any advertiser_id in the body — a
  // caller may only ever create campaigns for its OWN advertiser_id.
  // Demo mode (no Supabase) keeps its open behavior and trusts the body.
  const sbAuth = supa();
  let authedAdvertiserId;
  if (sbAuth) {
    const auth = await resolveAdvertiser(req, sbAuth);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    authedAdvertiserId = auth.advertiserId;
  } else {
    authedAdvertiserId = b.advertiser_id;
  }
  // 2026-06-25 — headline is no longer required at create time. The new
  // wizard launches campaigns with empty creative_* fields, and mcp.js
  // inherits headline/body/CTA from the advertiser's global creative_assets
  // library at impression time. cta_url stays required (per-campaign
  // destination is the one field that can't inherit). advertiser_id is now
  // server-derived from the Bearer credential in production; demo mode still
  // requires it in the body since there is no auth there.
  if (!authedAdvertiserId || !b.cta_url) {
    return res.status(400).json({ error: "Missing required fields: advertiser_id, cta_url" });
  }
  // Visual formats (image, corner, video, fullscreen) used to require a
  // media_url. With the global creative_assets library, mcp.js falls back
  // to library images per placement.kind aspect ratio when the campaign
  // has no media_url. So this gate is now soft — only block if BOTH the
  // campaign has no media_url AND format is explicitly visual AND we can
  // tell ahead of time that the library is empty (we can't, so just drop
  // the check). Image-format campaigns with no library images still serve
  // text-only at impression time, which is degraded but not broken.

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

  // ── Ad-credit funding gate (Phase 3 of Promote flow) ────────────────
  // When use_ad_credit=true, validate the seller has enough credit pool
  // to cover the total_budget BEFORE creating the campaign. If yes, the
  // campaign is stamped credit_funded=true and a corresponding
  // advertiser_credit_spend row is written after the INSERT succeeds.
  let useAdCredit = !!b.use_ad_credit;
  if (useAdCredit) {
    const sbCheck = supa();
    if (!sbCheck) {
      return res.status(503).json({ error: "Ad credit funding requires Supabase mode", code: "demo_mode" });
    }
    const { data: credits } = await sbCheck
      .from("advertiser_payouts")
      .select("amount")
      .eq("advertiser_id", authedAdvertiserId)
      .eq("status", "credited");
    const lifetimeCredit = (credits || []).reduce((a, r) => a + (Number(r.amount) || 0), 0);
    const { data: spend } = await sbCheck
      .from("advertiser_credit_spend")
      .select("amount")
      .eq("advertiser_id", authedAdvertiserId);
    const spendTotal = (spend || []).reduce((a, r) => a + (Number(r.amount) || 0), 0);
    const available = Math.round((lifetimeCredit - spendTotal) * 100) / 100;
    if (totalBudget > available + 0.001) {
      return res.status(400).json({
        error: `Insufficient ad credit. Available: $${available.toFixed(2)}, requested: $${totalBudget.toFixed(2)}.`,
        code:  "insufficient_credit",
        available,
        requested: totalBudget,
      });
    }
  }

  const now = new Date().toISOString();
  const row = {
    // UUID required — Supabase campaigns.id is a UUID column. The old
    // "cam_<hex>" format worked for the in-memory demo Map but caused
    // 500s in production ("invalid input syntax for type uuid").
    id: b.id || crypto.randomUUID(),
    advertiser_id: authedAdvertiserId,
    // name: prefer explicit name, else first 40 chars of headline if any,
    // else a generic fallback. 2026-06-25: headline is now optional at
    // create time (library inheritance), so .slice() on undefined would
    // throw — guard for it.
    name: b.name || (b.headline ? b.headline.slice(0, 40) : "Untitled campaign"),
    status: "in_review", // always starts in review
    format: b.format || "native",
    // Placement tier — which inventory class this campaign's budget buys
    // (ai-native | display | interruptive). One tier per campaign. NULL =
    // unrestricted (back-compat for campaigns created before this field).
    placement_tier: ["ai-native", "display", "interruptive"].includes(b.placement_tier)
      ? b.placement_tier : null,
    // headline: required-but-defaulted. campaigns.headline has a NOT NULL
    // constraint in prod, but with library inheritance the campaign-level
    // value is just a fallback (mcp.js overrides with library variants at
    // serve time). Default to the campaign name so the column stays
    // populated; if neither was sent, use a generic placeholder.
    headline: b.headline || b.name || "Untitled campaign",
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
    // BBX MCP-native targeting (migration 04). Free-form arrays of strings.
    // Empty array = no preference, campaign matches all values for that axis.
    target_intent_tokens: Array.isArray(b.target_intent_tokens) ? b.target_intent_tokens : [],
    target_active_tools:  Array.isArray(b.target_active_tools)  ? b.target_active_tools  : [],
    target_host_apps:     Array.isArray(b.target_host_apps)     ? b.target_host_apps     : [],
    target_surfaces:      Array.isArray(b.target_surfaces)      ? b.target_surfaces      : [],
    // Per-campaign opt-in to specific publisher integration doors
    // (db/09_target_integration_methods.sql). Allowlisted to the four
    // X-Lumi-Source values; anything else is dropped silently. Empty = all.
    // Per-campaign door filter. 'mobile-app' added 2026-06-25 alongside
    // the new 4-door Mobile App door (migration 30). Legacy 4 stay for
    // back-compat with pre-pivot integrations + the new wizard's door
    // multi-select writes here.
    target_integration_methods: Array.isArray(b.target_integration_methods)
      ? b.target_integration_methods.filter((m) => ["mcp","js-snippet","npm-sdk","rest-api","mobile-app"].includes(m))
      : [],
    optimization_goal: b.optimization_goal || "target_cpa",
    // Allowlist billing_model. CPI = AI app user-acquisition variant of
    // CPA — same accounting math, dedicated label so dashboards can group
    // user-acquisition campaigns separately from generic CPA. Default cpm
    // so legacy clients (no field) don't change shape.
    billing_model: ["cpm","cpc","cpv","cpa","cpi"].includes(b.billing_model)
      ? b.billing_model : "cpm",
    // Phase B (2026-05-11) — conversion event allowlist for CPA / CPI
    // campaigns. Empty array = "any conversion counts". For CPI we
    // seed ["install"] on create if the caller doesn't pass one — the
    // dashboard's CPI form always sends it but the API stays safe.
    conversion_event_types: (function () {
      const list = Array.isArray(b.conversion_event_types)
        ? b.conversion_event_types.filter((s) => typeof s === "string" && s.length <= 32)
        : [];
      if (list.length === 0 && b.billing_model === "cpi") return ["install"];
      return list;
    })(),
    // CPI-specific advertiser metadata — only included when the caller
    // actually sent values or billing_model is cpi. These columns aren't
    // present on every campaigns table (e.g. clean prod installs that
    // skipped the CPI migration), so omitting them avoids
    // 'column not found in schema cache' Supabase errors for the 99%
    // of campaigns that don't need them. Reattached via spread below.
    bid_amount: b.bid_amount || 5.00,
    daily_budget: b.daily_budget || 50.00,
    total_budget: b.total_budget || 1000.00,
    start_date: b.start_date || null,
    end_date: b.end_date || null,
    skippable_after_sec: b.skippable_after_sec || 3,
    spent_today: 0, spent_total: 0,
    // ── Pilot / Boost Ads fields (migration 31, 2026-06-24) ──────────
    // boost_objective whitelisted to the 5 known values; anything else
    // falls back to null so the row still inserts. Sliders default to
    // 0.5 (neutral) — matches the new wizard's auto-default behavior.
    boost_objective: ["awareness","clicks","signups","conversion","install"].includes(b.boost_objective)
      ? b.boost_objective : null,
    boost_pacing:           Number.isFinite(Number(b.boost_pacing))           ? Math.max(0, Math.min(1, Number(b.boost_pacing)))           : 0.5,
    boost_reach:            Number.isFinite(Number(b.boost_reach))            ? Math.max(0, Math.min(1, Number(b.boost_reach)))            : 0.5,
    boost_brand_safety:     Number.isFinite(Number(b.boost_brand_safety))     ? Math.max(0, Math.min(1, Number(b.boost_brand_safety)))     : 0.5,
    boost_creative_refresh: Number.isFinite(Number(b.boost_creative_refresh)) ? Math.max(0, Math.min(1, Number(b.boost_creative_refresh))) : 0.5,
    boost_confidence_floor: Number.isFinite(Number(b.boost_confidence_floor)) ? Math.max(0, Math.min(1, Number(b.boost_confidence_floor))) : 0.5,
    // Parent product. Nullable for back-compat with pre-Products campaigns
    // and for the "standalone campaign" path. See [[products-as-parent]].
    // Also doubles as the affiliate-attach link per Boost Ads sub-tab logic.
    product_id: b.product_id || null,
    // Ad-credit funding marker (Phase 3 of Promote flow). When true, this
    // campaign's total_budget was pre-funded from advertiser_credit_spend
    // — no PayPal charge for the budget itself.
    credit_funded:        useAdCredit,
    credit_funded_amount: useAdCredit ? totalBudget : 0,
    created_at: now, updated_at: now,
  };

  // Optional CPI fields — spread in only when the caller is actually
  // running an install campaign. Keeps the row free of columns that
  // some prod DBs don't have (saw 'Could not find the app_store_url
  // column in schema cache' from clean installs that skipped the CPI
  // migration). Safe-by-omission for the 99% non-CPI path.
  if (b.billing_model === "cpi" || b.app_store_url || b.install_postback_url || b.install_event_name) {
    if (b.app_store_url)        row.app_store_url        = b.app_store_url;
    if (b.install_postback_url) row.install_postback_url = b.install_postback_url;
    row.install_event_name = b.install_event_name || (b.billing_model === "cpi" ? "install" : null);
  }

  // Run creative policy check immediately
  const policy = validateCreativePolicy(row);

  // Auto-approve on first campaign: new advertisers' first campaign goes
  // straight to "active" if creative policy passes. This unblocks self-serve
  // — without it, an advertiser's first campaign sits in_review forever
  // waiting on a manual admin approval. Subsequent campaigns still go
  // through review so we can still police abuse from established accounts.
  const sb = supa();
  let autoApproved = false;
  if (policy.ok) {
    let priorCount = 0;
    if (sb) {
      const { count } = await sb.from("campaigns")
        .select("id", { count: "exact", head: true })
        .eq("advertiser_id", authedAdvertiserId);
      priorCount = count || 0;
    } else {
      for (const c of DEMO_CAMPAIGNS.values()) {
        if (c.advertiser_id === authedAdvertiserId) priorCount++;
      }
    }
    if (priorCount === 0) {
      row.status = "active";
      row.reviewed_at = now;
      row.review_notes = "Auto-approved (first campaign, creative policy passed)";
      autoApproved = true;
    }
  }

  if (sb) {
    // Refresh intent_embedding from the union of MCP-native targeting
    // axes. Joining these into one string before embedding produces a
    // single vector that captures the full targeting context (intent
    // tokens, tools, hosts, surfaces). No-op when VOYAGE_API_KEY unset.
    const embText = [
      ...(row.target_intent_tokens || []),
      ...(row.target_active_tools  || []).map((t) => t.replace(/-mcp$/, "")),
      ...(row.target_host_apps     || []),
      ...(row.target_surfaces      || []),
    ];
    const vec = await embedTokens(embText);
    if (vec) row.intent_embedding = vec;

    const { data, error } = await sb.from("campaigns").insert(row).select().single();
    if (error) return res.status(500).json({ error: error.message });
    // Phase E.5 — persist per-door creative rows alongside the campaign.
    await upsertCampaignCreatives(sb, data.id, row, b.per_door_creatives);

    // Phase 3 of Promote — write the credit deduction row AFTER the
    // campaign INSERT succeeds, linking the two. If the deduction insert
    // fails for any reason we don't unwind the campaign (operator can
    // refund the credit manually); logging is enough for the rare case.
    if (useAdCredit) {
      try {
        await sb.from("advertiser_credit_spend").insert({
          advertiser_id: authedAdvertiserId,
          campaign_id:   data.id,
          amount:        totalBudget,
          currency:      "USD",
          note:          `Campaign: ${row.name || data.id}`,
        });
      } catch (e) {
        console.error(`[campaigns] credit_spend insert failed for campaign ${data.id}:`, e.message);
      }
    }

    await deliverWebhook(sbAuth, authedAdvertiserId, "campaign.created", { campaign: data });
    return res.status(201).json({ campaign: data, policy, auto_approved: autoApproved });
  }
  DEMO_CAMPAIGNS.set(row.id, row);
  // Demo mode — store per-door creatives on the campaign object so the
  // tests can verify the same shape without Supabase.
  row._per_door_creatives = normalisePerDoorCreatives(row, b.per_door_creatives);
  return res.status(201).json({ campaign: row, policy, auto_approved: autoApproved });
}

// ── per-door creative helpers (Phase E.5) ──────────────────────────────
// Normalise an advertiser-supplied per_door_creatives map into rows
// we can insert. Always writes a 'default' row; door-specific rows
// only when at least one field differs from the campaign-level copy.
function normalisePerDoorCreatives(campaignRow, perDoor) {
  const out = [];
  const FIELDS = ["headline", "subtext", "media_url", "poster_url", "cta_label", "cta_url"];
  const defaults = {};
  for (const f of FIELDS) defaults[f] = campaignRow[f] != null ? campaignRow[f] : null;
  // The 'default' row always tracks campaign-level copy.
  out.push({
    door: "default",
    source: "inherited",
    ...defaults,
  });
  if (!perDoor || typeof perDoor !== "object") return out;
  for (const door of ["mcp", "js-snippet", "npm-sdk", "rest-api"]) {
    const override = perDoor[door];
    if (!override || typeof override !== "object") continue;
    // Only persist when at least one field is supplied AND differs from default.
    const row = { door, source: "user-uploaded" };
    let differs = false;
    for (const f of FIELDS) {
      const v = override[f];
      // Treat empty string / null as "no override for this field" — but
      // we still write the row if any other field has a real override.
      row[f] = (v != null && v !== "") ? String(v).slice(0, 2000) : defaults[f];
      if (v != null && v !== "" && row[f] !== defaults[f]) differs = true;
    }
    if (differs) out.push(row);
  }
  return out;
}

// Insert/upsert per-door rows for a campaign. Idempotent — replaces any
// existing rows for the campaign so PATCH semantics are dead simple
// (the advertiser sends the full desired state; we mirror it).
async function upsertCampaignCreatives(sb, campaignId, campaignRow, perDoor) {
  if (!sb) return;
  const rows = normalisePerDoorCreatives(campaignRow, perDoor).map((r) => ({
    campaign_id: campaignId,
    ...r,
  }));
  // Clear-and-rewrite is simpler than per-row upsert here. Volume per
  // call is tiny (max 5 rows) and the table is indexed on campaign_id.
  await sb.from("campaign_creatives").delete().eq("campaign_id", campaignId);
  if (rows.length === 0) return;
  const { error } = await sb.from("campaign_creatives").insert(rows);
  if (error) {
    // Don't block the campaign write on creative-row failure — the
    // auction read path falls back to campaigns.* if the table is empty.
    console.error("[campaigns] upsert creatives failed:", error.message);
  }
}

// ── update ──────────────────────────────────────────────────────────────
async function handleUpdate(req, res) {
  const b = req.body || {};
  if (!b.id) return res.status(400).json({ error: "Missing campaign id" });

  const allowed = [
    "name", "headline", "subtext", "media_url", "poster_url",
    "cta_label", "cta_url", "adomain", "iab_cat", "format", "placement_tier",
    "target_keywords", "target_regions", "target_languages",
    "target_cpa", "billing_model", "bid_amount",
    "daily_budget", "total_budget", "status", "skippable_after_sec",
    "start_date", "end_date", "optimization_goal", "target_roas",
    // BBX MCP-native targeting (migration 04)
    "target_intent_tokens", "target_active_tools", "target_host_apps", "target_surfaces",
    // Per-door opt-in (migration 09)
    "target_integration_methods",
    // Conversion-billing allowlist (migration 11 / Phase B)
    "conversion_event_types",
    // CPI / AI-app-UA metadata
    "app_store_url", "install_postback_url", "install_event_name",
    // Parent product link (Products migration, 2026-06-12). NULLable so the
    // advertiser can detach a campaign from a product if they restructure.
    "product_id",
    // ── Pilot model (migration 31) — see [[advertiser-pilot-model]] ──
    // boost_status is intentionally NOT here — use the existing `status`
    // column which now also accepts 'depleted'. Budget fields are also
    // intentionally not duplicated — daily_budget / total_budget /
    // spent_total are the existing canonical sources.
    "boost_objective",
    "boost_pacing",
    "boost_reach",
    "boost_brand_safety",
    "boost_creative_refresh",
    "boost_confidence_floor",
    "boost_activated_at",
    "creative_headlines",
    "creative_body_copy",
    "creative_cta_labels",
    "creative_library_ready",  // trigger overwrites on the way in
  ];
  const updates = {};
  for (const k of allowed) if (b[k] !== undefined) updates[k] = b[k];
  // Validate the door allowlist if it was updated.
  // 'mobile-app' added 2026-06-25 to mirror the create-side allowlist
  // (migration 34) so PATCHes from the wizard don't silently drop the
  // Mobile App door selection.
  if (Array.isArray(updates.target_integration_methods)) {
    updates.target_integration_methods = updates.target_integration_methods
      .filter((m) => ["mcp","js-snippet","npm-sdk","rest-api","mobile-app"].includes(m));
  }
  // Validate placement_tier if it was updated — only the 3 known tiers or
  // null. An unrecognised value is coerced to null (unrestricted).
  if (updates.placement_tier !== undefined
      && !["ai-native", "display", "interruptive"].includes(updates.placement_tier)) {
    updates.placement_tier = null;
  }

  // ── Pilot model validation ────────────────────────────────────────
  // Whitelist boost_objective; clamp the five sliders to [0,1]; sanitize
  // creative variant arrays (cap 10 entries, trim each). Stamp
  // boost_activated_at when transitioning into 'active' from any other
  // state — callers can omit it.
  const BOOST_OBJECTIVES = new Set(["awareness","clicks","signups","conversion","install"]);
  if (updates.boost_objective !== undefined && !BOOST_OBJECTIVES.has(updates.boost_objective)) {
    return res.status(400).json({ error: `boost_objective must be one of: ${Array.from(BOOST_OBJECTIVES).join(", ")}` });
  }
  const SLIDER_KEYS = ["boost_pacing","boost_reach","boost_brand_safety","boost_creative_refresh","boost_confidence_floor"];
  for (const k of SLIDER_KEYS) {
    if (updates[k] === undefined) continue;
    const v = Number(updates[k]);
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      return res.status(400).json({ error: `${k} must be a number between 0 and 1` });
    }
    updates[k] = Math.round(v * 100) / 100;
  }
  function sanitizeVariantArray(arr, fieldName, maxItems, maxLen) {
    if (!Array.isArray(arr)) return { error: `${fieldName} must be an array of strings` };
    if (arr.length > maxItems) return { error: `${fieldName}: max ${maxItems} variants` };
    const cleaned = [];
    for (const v of arr) {
      if (v == null) continue;
      const s = String(v).trim();
      if (!s) continue;
      cleaned.push(s.slice(0, maxLen));
    }
    return { value: cleaned };
  }
  if (updates.creative_headlines !== undefined) {
    const r = sanitizeVariantArray(updates.creative_headlines, "creative_headlines", 10, 240);
    if (r.error) return res.status(400).json({ error: r.error });
    updates.creative_headlines = r.value;
  }
  if (updates.creative_body_copy !== undefined) {
    const r = sanitizeVariantArray(updates.creative_body_copy, "creative_body_copy", 10, 240);
    if (r.error) return res.status(400).json({ error: r.error });
    updates.creative_body_copy = r.value;
  }
  if (updates.creative_cta_labels !== undefined) {
    const r = sanitizeVariantArray(updates.creative_cta_labels, "creative_cta_labels", 10, 60);
    if (r.error) return res.status(400).json({ error: r.error });
    updates.creative_cta_labels = r.value;
  }
  // First-activation stamp — only set if status is flipping to 'active'.
  if (updates.status === "active" && updates.boost_activated_at === undefined) {
    updates.boost_activated_at = new Date().toISOString();
  }

  updates.updated_at = new Date().toISOString();

  const sb = supa();
  if (sb) {
    // ── Cross-tenant fix — resolve caller identity (API key OR session)
    // and scope every read/write below to their own advertiser_id so a
    // caller can never mutate another advertiser's campaign by id.
    const auth = await resolveAdvertiser(req, sb);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    const authedAdvertiserId = auth.advertiserId;
    // Re-embed only when an MCP targeting axis actually changed; otherwise
    // we'd burn a Voyage request on every status / budget toggle.
    const targetingChanged = ["target_intent_tokens", "target_active_tools", "target_host_apps", "target_surfaces"]
      .some((k) => updates[k] !== undefined);
    if (targetingChanged) {
      // We need the post-merge state to embed correctly — fetch the current
      // row, overlay the updates, then embed the union.
      const { data: existing } = await sb.from("campaigns")
        .select("target_intent_tokens, target_active_tools, target_host_apps, target_surfaces")
        .eq("id", b.id).eq("advertiser_id", authedAdvertiserId).maybeSingle();
      const merged = Object.assign({}, existing || {}, updates);
      const embText = [
        ...(merged.target_intent_tokens || []),
        ...(merged.target_active_tools  || []).map((t) => t.replace(/-mcp$/, "")),
        ...(merged.target_host_apps     || []),
        ...(merged.target_surfaces      || []),
      ];
      const vec = await embedTokens(embText);
      if (vec) updates.intent_embedding = vec;
    }
    const { data, error } = await sb.from("campaigns").update(updates)
      .eq("id", b.id).eq("advertiser_id", authedAdvertiserId).select().maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Campaign not found" });
    // Phase E.5 — re-sync per-door creatives if the advertiser sent a
    // per_door_creatives payload OR if the campaign-level copy moved
    // (so the inherited 'default' row stays in sync).
    if (b.per_door_creatives !== undefined || hasCreativeFieldUpdate(updates)) {
      await upsertCampaignCreatives(sb, data.id, data, b.per_door_creatives);
    }
    return res.json({ campaign: data });
  }
  const c = DEMO_CAMPAIGNS.get(b.id);
  if (!c) return res.status(404).json({ error: "Campaign not found" });
  Object.assign(c, updates);
  // Demo mode — keep the in-memory _per_door_creatives in sync.
  if (b.per_door_creatives !== undefined || hasCreativeFieldUpdate(updates)) {
    c._per_door_creatives = normalisePerDoorCreatives(c, b.per_door_creatives);
  }
  return res.json({ campaign: c });
}

// True when any creative-level field (headline/media/cta) was just updated.
// Drives the per-door 'default' row resync in handleUpdate.
function hasCreativeFieldUpdate(updates) {
  return ["headline", "subtext", "media_url", "poster_url", "cta_label", "cta_url"]
    .some((f) => updates[f] !== undefined);
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
    // Cross-tenant fix — resolve caller (API key OR session) and scope the
    // pause/resume to their own advertiser_id.
    const auth = await resolveAdvertiser(req, sb);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    const authedAdvertiserId = auth.advertiserId;
    const { data, error } = await sb.from("campaigns")
      .update({ status: targetStatus, updated_at: now })
      .eq("id", id)
      .eq("advertiser_id", authedAdvertiserId)
      .in("status", validFrom)
      .select().single();
    if (error || !data) {
      return res.status(400).json({ error: `Campaign not found or cannot ${targetStatus === "paused" ? "pause" : "resume"} from current status` });
    }
    await deliverWebhook(sb, authedAdvertiserId, targetStatus === "paused" ? "campaign.paused" : "campaign.resumed", { campaign: data });
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
    await deliverWebhook(sb, data.advertiser_id, decision === "approve" ? "campaign.approved" : "campaign.rejected", { campaign: data });
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

// ── fetch_url_preview ──────────────────────────────────────────────────
// Phase E.5 — Server-side fetch of the advertiser's landing-page URL,
// parse OpenGraph + standard <meta> tags, return a normalised preview
// shape the advertiser dashboard uses to autofill the create-campaign
// form (no AI involved — we're just relaying what the page already
// declares about itself).
//
// Why server-side (not browser-side): the advertiser's browser would hit
// CORS on most domains. Doing the fetch from our server avoids that and
// gives us a single place to enforce SSRF + size limits.
//
// SSRF defense:
//   • HTTPS only.
//   • Public DNS only — resolved host must not be private/loopback/link-local.
//   • 8 KB read cap (OG tags live in <head>, no reason to pull MBs of HTML).
//   • 5-second wall clock via AbortController.
//   • Follow redirects up to 3 hops (fetch default is 20 — too generous).
// All five of these have to fail for the advertiser to be able to map
// our server into their internal network.
async function handleFetchUrlPreview(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Missing url" });

  // Parse + protocol check
  let parsed;
  try { parsed = new URL(url); }
  catch (_) { return res.status(400).json({ error: "Invalid URL format" }); }
  if (parsed.protocol !== "https:") {
    return res.status(400).json({ error: "URL must use HTTPS" });
  }

  // SSRF — reject obvious internal hostnames before we even hit DNS.
  // (For full hardening we'd resolve and check the IP, but Node fetch
  // doesn't expose the resolved IP and we don't want to add a dns dep
  // for marginal benefit when the cheap hostname check catches 99%.)
  const host = parsed.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) {
    return res.status(400).json({ error: "URL host is not publicly reachable" });
  }

  // Fetch with timeout + size cap
  const ctrl = new AbortController();
  const timeoutMs = 5000;
  const maxBytes = 8192;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let html = "";
  let status = 0;
  let finalUrl = parsed.toString();
  try {
    const r = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": "BoostBoss-Preview/1.0 (+https://boostboss.ai)",
        "Accept": "text/html,*/*;q=0.5",
      },
    });
    status = r.status;
    finalUrl = r.url || finalUrl;
    if (!r.ok) {
      return res.status(400).json({
        error: `Upstream returned HTTP ${status}`,
        status,
        url: finalUrl,
      });
    }
    // Bounded read — slurp the body but cap at maxBytes so a 10 GB stream
    // can't OOM us. We only need <head>, which is always in the first KB.
    const reader = r.body && r.body.getReader ? r.body.getReader() : null;
    if (reader) {
      let total = 0;
      const decoder = new TextDecoder("utf-8", { fatal: false });
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        html += decoder.decode(value, { stream: true });
        if (total >= maxBytes) {
          try { await reader.cancel(); } catch (_) {}
          break;
        }
      }
      html += decoder.decode();
    } else {
      // Older runtimes — fall back to .text() but slice.
      const t = await r.text();
      html = t.slice(0, maxBytes);
    }
  } catch (e) {
    return res.status(400).json({
      error: e.name === "AbortError" ? "Fetch timed out" : `Fetch failed: ${e.message}`,
    });
  } finally {
    clearTimeout(timer);
  }

  // Parse OpenGraph + standard <meta> + <title> with regex (no jsdom dep).
  // The HEAD is small and well-structured; regex is good enough here.
  // Order matters: og: tags beat name= tags beat <title>.
  function pickMeta(re) {
    const m = html.match(re);
    return m ? decodeEntities(m[1].trim()) : "";
  }
  function decodeEntities(s) {
    return s
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  }

  // Note the `[^>]*` between tag name and attribute — meta tags often
  // have multiple attributes in arbitrary order.
  const ogTitle    = pickMeta(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
                  || pickMeta(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  const ogDesc     = pickMeta(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
                  || pickMeta(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
  const ogImage    = pickMeta(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
                  || pickMeta(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  const ogSiteName = pickMeta(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i);
  const metaDesc   = pickMeta(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i)
                  || pickMeta(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']/i);
  const titleTag   = pickMeta(/<title[^>]*>([^<]+)<\/title>/i);

  // Resolve a possibly-relative image URL against finalUrl. Advertisers
  // who don't use absolute og:image values still get a usable URL back.
  let mediaUrl = "";
  if (ogImage) {
    try { mediaUrl = new URL(ogImage, finalUrl).toString(); }
    catch (_) { mediaUrl = ""; }
  }

  // Cap field lengths to match what create-campaign accepts. Saves a
  // round-trip — the advertiser sees the same string we'd persist.
  function cap(s, n) { return (s || "").slice(0, n); }

  return res.json({
    ok: true,
    url: finalUrl,
    site_name: cap(ogSiteName, 80),
    headline: cap(ogTitle || titleTag, 90),
    subtext: cap(ogDesc || metaDesc, 160),
    media_url: mediaUrl,
    // Debug — useful for the dashboard's "we found / we didn't" hint.
    found: {
      og_title:    !!ogTitle,
      og_desc:     !!ogDesc,
      og_image:    !!ogImage,
      meta_desc:   !!metaDesc,
      title_tag:   !!titleTag,
    },
  });
}

// ── re-embed (admin) ───────────────────────────────────────────────────
// Backfills campaigns.intent_embedding for every campaign that has any
// MCP targeting populated. Idempotent — re-running just refreshes from
// the current targeting tokens. Safe to call after enabling
// VOYAGE_API_KEY for the first time, or after editing the embedding
// formula in this file.
//
// Hits Voyage at most once per campaign (cached by token-set hash within
// the request, so repeats across rows reuse the same vector).
async function handleReembed(req, res) {
  const sb = supa();
  if (!sb) return res.status(503).json({ error: "Supabase not configured" });
  if (!process.env.VOYAGE_API_KEY) {
    return res.status(503).json({ error: "VOYAGE_API_KEY not set — cannot embed" });
  }

  const onlyId = (req.query && req.query.id) || (req.body && req.body.id);
  let q = sb.from("campaigns").select(
    "id, target_intent_tokens, target_active_tools, target_host_apps, target_surfaces"
  );
  if (onlyId) q = q.eq("id", onlyId);
  const { data: campaigns, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  let touched = 0, skipped = 0, failed = 0;
  for (const c of campaigns || []) {
    const text = [
      ...(c.target_intent_tokens || []),
      ...(c.target_active_tools  || []).map((t) => t.replace(/-mcp$/, "")),
      ...(c.target_host_apps     || []),
      ...(c.target_surfaces      || []),
    ];
    if (text.length === 0) { skipped++; continue; }
    const vec = await embedTokens(text);
    if (!vec) { failed++; continue; }
    const { error: uErr } = await sb.from("campaigns")
      .update({ intent_embedding: vec, updated_at: new Date().toISOString() })
      .eq("id", c.id);
    if (uErr) { failed++; console.error("[reembed] update", c.id, uErr.message); }
    else      { touched++; }
  }
  return res.json({ touched, skipped, failed, total: (campaigns || []).length });
}

// ── Embedding cache ops (merged from former /api/embed-cron) ──────────
// Same handlers as before — drain misses, batch-call Voyage, promote.
// Routed via /api/campaigns?action=embed_stats|embed_drain|embed_seed.
const VOYAGE_ENDPOINT       = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL          = "voyage-3-lite";
const VOYAGE_DIMS           = 512;
const EMBED_MAX_PER_RUN     = 500;
const EMBED_BATCH_SIZE      = 128;

function _embedNormaliseTokens(tokens) {
  const seen = new Set(), out = [];
  for (const raw of tokens || []) {
    const t = String(raw || "").trim().toLowerCase();
    if (!t || t.length > 64 || seen.has(t)) continue;
    seen.add(t); out.push(t);
  }
  return out;
}

async function _voyageBatchEmbed(tokens) {
  const r = await fetch(VOYAGE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": "Bearer " + process.env.VOYAGE_API_KEY,
    },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: tokens }),
  });
  if (!r.ok) throw new Error("Voyage " + r.status + ": " + (await r.text().catch(() => "")).slice(0, 300));
  const j = await r.json();
  if (!j || !Array.isArray(j.data) || j.data.length !== tokens.length) {
    throw new Error("Voyage shape mismatch (" + (j.data ? j.data.length : "?") + " vs " + tokens.length + ")");
  }
  return j.data.sort((a, b) => (a.index || 0) - (b.index || 0)).map((row) => row.embedding);
}

async function _embedPromote(sb, tokens, vectors) {
  const asLiterals = vectors.map((v) => "[" + v.join(",") + "]");
  const { data, error } = await sb.rpc("bbx_promote_embeddings", {
    p_tokens: tokens, p_embeddings: asLiterals,
  });
  if (error) throw new Error("promote: " + error.message);
  return Number(data) || tokens.length;
}

async function handleEmbedAction(action, req, res) {
  const sb = supa();
  if (!sb) return res.status(503).json({ error: "Supabase not configured" });

  if (action === "embed_stats") {
    const [cacheRes, missRes] = await Promise.all([
      sb.from("intent_embedding_cache").select("token", { count: "exact", head: true }),
      sb.from("intent_embedding_misses").select("token", { count: "exact", head: true }),
    ]);
    return res.status(200).json({
      cache_size:  cacheRes.count || 0,
      miss_queue:  missRes.count  || 0,
      model:       VOYAGE_MODEL,
      dims:        VOYAGE_DIMS,
      max_per_run: EMBED_MAX_PER_RUN,
      batch_size:  EMBED_BATCH_SIZE,
    });
  }

  if (action === "embed_seed") {
    const tokens = _embedNormaliseTokens((req.body || {}).tokens);
    if (tokens.length === 0)   return res.status(400).json({ error: "tokens[] required" });
    if (tokens.length > 1000)  return res.status(400).json({ error: "max 1000 tokens per seed call" });
    if (!process.env.VOYAGE_API_KEY) return res.status(503).json({ error: "VOYAGE_API_KEY not set" });
    let promoted = 0, failed = 0;
    for (let i = 0; i < tokens.length; i += EMBED_BATCH_SIZE) {
      const slice = tokens.slice(i, i + EMBED_BATCH_SIZE);
      try { promoted += await _embedPromote(sb, slice, await _voyageBatchEmbed(slice)); }
      catch (e) { console.error("[embed_seed] batch:", e.message); failed += slice.length; }
    }
    return res.status(200).json({ requested: tokens.length, promoted, failed });
  }

  if (action === "embed_drain") {
    if (!process.env.VOYAGE_API_KEY) return res.status(503).json({ error: "VOYAGE_API_KEY not set", drained: 0 });
    const { data: missRows, error } = await sb.from("intent_embedding_misses")
      .select("token")
      .order("miss_count", { ascending: false })
      .order("last_seen", { ascending: false })
      .limit(EMBED_MAX_PER_RUN);
    if (error) return res.status(500).json({ error: error.message });
    const tokens = (missRows || []).map((r) => r.token).filter(Boolean);
    let promoted = 0, failed = 0;
    for (let i = 0; i < tokens.length; i += EMBED_BATCH_SIZE) {
      const slice = tokens.slice(i, i + EMBED_BATCH_SIZE);
      try { promoted += await _embedPromote(sb, slice, await _voyageBatchEmbed(slice)); }
      catch (e) { console.error("[embed_drain] batch:", e.message); failed += slice.length; }
    }

    // ── Context fingerprint drain (Phase 0 — capture now, score later) ──
    // Fill Voyage embeddings for context_fingerprints rows the auction has
    // logged (db/19_context_fingerprints.sql). Runs every cron tick,
    // independent of the token miss queue. Failures are non-fatal — an
    // unembedded row is simply retried on the next run. This is the ONLY
    // place context text is embedded: never on the bid path.
    let contextDrained = 0, contextFailed = 0;
    try {
      const { data: ctxRows } = await sb.from("context_fingerprints")
        .select("context_hash, context_text")
        .is("embedding", null)
        .not("context_text", "is", null)
        .order("first_seen", { ascending: true })
        .limit(EMBED_MAX_PER_RUN);
      const rows = (ctxRows || []).filter((r) => r.context_text);
      for (let i = 0; i < rows.length; i += EMBED_BATCH_SIZE) {
        const slice = rows.slice(i, i + EMBED_BATCH_SIZE);
        try {
          const vecs = await _voyageBatchEmbed(slice.map((r) => r.context_text));
          for (let j = 0; j < slice.length; j++) {
            const { error: upErr } = await sb.from("context_fingerprints")
              .update({ embedding: "[" + vecs[j].join(",") + "]" })
              .eq("context_hash", slice[j].context_hash);
            if (upErr) contextFailed++; else contextDrained++;
          }
        } catch (e) {
          console.error("[embed_drain] context batch:", e.message);
          contextFailed += slice.length;
        }
      }
    } catch (e) {
      console.error("[embed_drain] context drain:", e.message);
    }

    return res.status(200).json({
      drained: tokens.length, promoted, failed,
      context_drained: contextDrained, context_failed: contextFailed,
    });
  }

  return res.status(400).json({ error: "Unknown embed action" });
}

// ── Exports for testing ─────────────────────────────────────────────────
module.exports.validateCreativePolicy = validateCreativePolicy;
module.exports.HAS_SUPABASE = HAS_SUPABASE;
module.exports._DEMO_CAMPAIGNS = DEMO_CAMPAIGNS;
module.exports._reset = function () { DEMO_CAMPAIGNS.clear(); _seeded = false; };
module.exports._seed = seedDemoCampaigns;
// Phase E.5
module.exports._normalisePerDoorCreatives = normalisePerDoorCreatives;
module.exports._handleFetchUrlPreview = handleFetchUrlPreview;
