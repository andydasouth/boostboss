/**
 * Boost Boss — Auction Logging
 *
 * One row per auction (mcp.js JSON-RPC and rtb.js OpenRTB share the same
 * schema). Captures: request fingerprint, eligibility breakdown per filter
 * stage, scored candidates with components, and outcome. 30-day retention
 * via bbx_prune_auction_logs() (see db/08_auction_logs.sql).
 *
 * Two execution modes — identical interface so callers never branch:
 *   • PRODUCTION — Supabase insert (fire-and-forget; never blocks auction)
 *   • DEMO       — in-process ring buffer, capacity 500, oldest first out
 *
 * Auctions must NEVER fail because logging failed. All Supabase calls are
 * fire-and-forget with errors caught and console.warn'd.
 */

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
  } catch (_) {
    return null;
  }
}

// ── Demo ring buffer ────────────────────────────────────────────────────
const DEMO_CAPACITY = 500;
const DEMO_BUFFER = []; // Newest at the end

function pushDemo(row) {
  DEMO_BUFFER.push(row);
  while (DEMO_BUFFER.length > DEMO_CAPACITY) DEMO_BUFFER.shift();
}

// ── Sanitization helpers ───────────────────────────────────────────────
// Keep candidate count + payload size sane to avoid blowing up row size.
const MAX_CANDIDATES   = 10;
const MAX_CONTEXT_LEN  = 500;

function truncStr(s, n = MAX_CONTEXT_LEN) {
  if (typeof s !== "string") return s;
  return s.length > n ? s.slice(0, n) : s;
}

// Compact, deterministic hash so we can correlate session_id across
// auctions without storing raw session strings. djb2-ish.
function hashSession(s) {
  if (!s) return null;
  const str = String(s);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return "sh_" + (Math.abs(h).toString(36));
}

function trimCandidates(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates.slice(0, MAX_CANDIDATES).map((c) => ({
    campaign_id:         c.campaign_id || null,
    campaign_name:       c.campaign_name || null,
    p_click:             c.p_click ?? null,
    p_convert:           c.p_convert ?? null,
    signal_contributions: Array.isArray(c.signal_contributions) ? c.signal_contributions.slice(0, 6) : [],
    price_cpm:           c.price_cpm ?? null,
    factors:             c.factors || null,
    kw_boost:            c.kw_boost ?? null,
    effective_price_cpm: c.effective_price_cpm ?? null,
    self_promote:        !!c.self_promote,
    won:                 !!c.won,
  }));
}

/**
 * recordAuction(log) — fire-and-forget. Does not return a promise that
 * callers should await. Errors are swallowed; the auction must not fail
 * because logging failed.
 *
 * Required fields:
 *   auction_id (string)   — unique, primary key
 *   surface ('mcp'|'rtb')
 *   outcome ('won' | 'no_match' | 'below_floor' | 'rate_limited' | 'sandbox' | 'error')
 *
 * Recommended fields:
 *   publisher_id, publisher_domain, integration_method, is_sandbox,
 *   request, eligibility, candidates, winner_campaign_id, winning_price_cpm,
 *   no_fill_reason, latency_ms
 */
function recordAuction(log) {
  if (!log || !log.auction_id) return;

  const ts = log.ts || new Date().toISOString();
  const row = {
    auction_id:         log.auction_id,
    ts,
    surface:            log.surface || "mcp",
    publisher_id:       log.publisher_id || null,
    publisher_domain:   log.publisher_domain || null,
    integration_method: log.integration_method || null,
    is_sandbox:         !!log.is_sandbox,
    request:            sanitizeRequest(log.request || {}),
    eligibility:        log.eligibility || {},
    candidates:         trimCandidates(log.candidates || []),
    winner_campaign_id: log.winner_campaign_id || null,
    winning_price_cpm:  log.winning_price_cpm ?? null,
    outcome:            log.outcome || "no_match",
    no_fill_reason:     log.no_fill_reason || null,
    latency_ms:         log.latency_ms ?? null,
  };

  const sb = supa();
  if (sb) {
    // Fire-and-forget. Caller never awaits.
    sb.from("auction_logs").insert(row).then(
      () => {},
      (err) => console.warn("[auction_log] supabase insert failed:", err && err.message)
    );
    return;
  }
  pushDemo(row);
}

function sanitizeRequest(req) {
  if (!req || typeof req !== "object") return {};
  const out = {};
  // Whitelist fields we want to log
  if (req.host)                     out.host             = truncStr(req.host, 200);
  if (req.host_app)                 out.host_app         = truncStr(req.host_app, 80);
  if (req.surface)                  out.surface          = truncStr(req.surface, 40);
  if (req.country)                  out.country          = truncStr(req.country, 8);
  if (req.user_region)              out.user_region      = truncStr(req.user_region, 16);
  if (req.user_language)            out.user_language    = truncStr(req.user_language, 8);
  if (Array.isArray(req.intent_tokens)) out.intent_tokens = req.intent_tokens.slice(0, 16).map((t) => truncStr(t, 40));
  if (Array.isArray(req.active_tools))  out.active_tools  = req.active_tools.slice(0, 16).map((t) => truncStr(t, 40));
  if (req.format_preference)        out.format_preference = truncStr(req.format_preference, 32);
  if (typeof req.context_summary === "string") out.context_summary = truncStr(req.context_summary, MAX_CONTEXT_LEN);
  if (req.session_id)               out.session_id_hash  = hashSession(req.session_id);
  if (req.placement_id)             out.placement_id     = truncStr(req.placement_id, 80);
  if (typeof req.floor_cpm === "number") out.floor_cpm  = req.floor_cpm;
  if (req.bid_request_id)           out.bid_request_id   = truncStr(req.bid_request_id, 80);
  return out;
}

// ── Test helpers (also useful for the eventual /api/auction-logs read endpoint)
function _getDemoLogs(limit = 50) {
  return DEMO_BUFFER.slice(-limit).reverse();
}

function _reset() {
  DEMO_BUFFER.length = 0;
  _supabase = null;
}

module.exports = {
  recordAuction,
  HAS_SUPABASE,
  _getDemoLogs,
  _reset,
};
