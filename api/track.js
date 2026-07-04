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

// Revenue split (Phase F, 2026-06-04). See api/billing.js for full doc.
// Two env vars: BBX_RTB_FEE (6.5%, demand-side) + BBX_NETWORK_TAKE (23.5%,
// platform margin). Sum is the combined take. Legacy BBX_TAKE_RATE wins
// if set (back-compat). Publisher share = 1 - TAKE_RATE = 70% by default.
const RTB_FEE      = Number(process.env.BBX_RTB_FEE)      || 0.065;
const NETWORK_TAKE = Number(process.env.BBX_NETWORK_TAKE) || 0.235;
const TAKE_RATE    = Number(process.env.BBX_TAKE_RATE)
                     || +(RTB_FEE + NETWORK_TAKE).toFixed(6); // 0.30 default

// Phase E Day 2 — per-event balance accrual. Imported here so it runs
// inside the same handler invocation as the event insert; lazy require
// keeps cold-start cost minimal when balance isn't wired (e.g. legacy
// callers exclusively in demo mode).
const publisherBalance = require("./_lib/publisher_balance.js");
const boostCredits = require("./_lib/boost_credits.js");

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
  // Context fingerprint (db/19_context_fingerprints.sql). Minted by the
  // auction (api/mcp.js) and carried on the `ctx` query key of every
  // tracking URL, so this feedback event joins back to the semantic
  // context that produced it. NULL for legacy callers — never required.
  const contextHash = params.ctx || params.context_hash || null;

  // ── Click redirect (Bot door) ───────────────────────────────────────
  // A GET beacon may carry a `to` destination. Bot platforms (Discord /
  // Telegram / Slack) give a link button exactly ONE URL and never notify
  // the bot when it's tapped — so the tracking URL itself must both record
  // the click and forward the user to the advertiser. http/https only,
  // which blocks javascript:/data: redirect-based XSS.
  let clickRedirectTo = null;
  {
    const raw = params.to || params.redirect || null;
    if (raw) {
      try {
        const u = new URL(String(raw));
        if (u.protocol === "http:" || u.protocol === "https:") clickRedirectTo = u.toString();
      } catch (_e) { /* invalid URL — ignore, fall back to the pixel */ }
    }
  }
  // Resolve a GET response: 302 to the destination when one was supplied,
  // otherwise the 1×1 tracking pixel. Used at every GET exit point.
  function endGetBeacon() {
    if (clickRedirectTo) {
      res.setHeader("Location", clickRedirectTo);
      res.setHeader("Cache-Control", "no-store");
      return res.status(302).end();
    }
    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Cache-Control", "no-store");
    return res.send(PIXEL_GIF);
  }
  const intentMatchScore = params.ims != null ? Number(params.ims)
                       : (params.intent_match_score != null ? Number(params.intent_match_score) : null);

  // Sandbox flag — set by /api/mcp's sandbox short-circuit (pub_test_*
  // / sk_test_* publishers). When true: skip cost computation, skip
  // budget deduction, tag the row is_sandbox=true so dashboards can
  // exclude sandbox traffic from real metrics. See db/07_sandbox.sql
  // and api/_lib/sandbox.js.
  const isSandbox = params.sandbox === "1" || params.sandbox === 1
                 || params.bbx_sandbox === "1" || params.bbx_sandbox === 1
                 || (typeof auctionId === "string" && auctionId.startsWith("auc_sandbox_"));

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
  // This prevents attackers from burning budgets on non-existent or others' campaigns.
  // Sandbox traffic skips this check: sandbox creatives are hardcoded in
  // api/_lib/sandbox.js (not in the campaigns table) and have cost=0,
  // so the budget-drain attack vector doesn't apply. Without this bypass,
  // sandbox impression beacons 404 and never write to events. Surfaced by
  // Door 4 / Telegram internal validation 2026-05-08.
  if (["impression", "click", "video_complete"].includes(event) && !isSandbox) {
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
  let integrationMethod = ["mcp", "js-snippet", "npm-sdk", "rest-api"].includes(_src)
    ? _src
    : null;

  // ── Phase B: inherit integration_method + sandbox from the originating
  // auction when this is a conversion event. The advertiser-side pixel
  // (public/pixel.js) doesn't know which door served the impression, so
  // without inheritance every conversion ends up with integration_method=null
  // and dashboard slices break.
  let inheritedSandbox = null;
  if (event === "conversion" && auctionId && (!integrationMethod || integrationMethod === "rest-api")) {
    const sbI = supa();
    if (sbI) {
      const { data: parent } = await sbI.from("events")
        .select("integration_method, is_sandbox")
        .eq("auction_id", auctionId)
        .eq("event_type", "impression")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (parent) {
        if (!integrationMethod && parent.integration_method) {
          integrationMethod = parent.integration_method;
        }
        if (parent.is_sandbox === true) inheritedSandbox = true;
      }
    }
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
    // BBX auction-keyed fields (columns added by db/04_bbx_mcp_extensions.sql §3).
    // All nullable; legacy callers without auction context still work.
    auction_id:   auctionId,
    placement_id: placementId,
    surface:      surface,
    format:       format,
    intent_match_score: Number.isFinite(intentMatchScore) ? intentMatchScore : null,
    anonymous_id: anonymousId,
    // Context fingerprint (db/19_context_fingerprints.sql). Joins this
    // feedback event back to the semantic context of the originating
    // request. NULL allowed; legacy callers without context still work.
    context_hash: contextHash,
    // Conversion fields (db/05_bbx_conversions.sql). Only populated when
    // event === 'conversion'; null otherwise.
    conversion_type: event === "conversion" ? conversionType : null,
    value_cents:     event === "conversion" ? valueCents     : null,
    external_id:     event === "conversion" ? externalId     : null,
    currency:        event === "conversion" ? currency       : null,
    // Integration source (db/06_integration_method.sql). NULL allowed.
    integration_method: integrationMethod,
    // Sandbox flag (db/07_sandbox.sql). True when the event came from a
    // pub_test_* / sk_test_* publisher; dashboard queries WHERE is_sandbox=false
    // to exclude test traffic from real metrics. For conversions, inherit
    // sandbox from the parent auction (Phase B) so a sandbox impression
    // followed by a real /api/track conversion call is still tagged sandbox.
    is_sandbox: isSandbox || inheritedSandbox === true,
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
        if (req.method === "GET") return endGetBeacon();
        return res.json({
          tracked: true, deduplicated: true, event,
          campaign_id: campaignId, auction_id: auctionId,
        });
      }
    }

    // Insert with cost pre-computed so we never need a second update (fixes race condition)
    // Sandbox events skip cost computation entirely — record stays at cost=0,
    // payout=0, and no budget is deducted. is_sandbox tags the row so the
    // dashboard can exclude it from real metrics. CPA conversion events also
    // count here (Phase B): when billing_model='cpa' and the conversion_type
    // matches the campaign's conversion_event_types allowlist, charge bid_amount.
    const billable = ["impression", "click", "video_complete", "conversion"].includes(event);
    // Calibration gate (cold-start, db/29_publisher_calibration.sql): a publisher in
    // 'calibrating' status serves real ads but neither side is charged — the impression
    // only proves traffic and counts toward graduation. Default status 'live' (and a
    // missing column / unapplied migration) leaves all existing billing behavior unchanged.
    let calibrating = false;
    if (!isSandbox && !(inheritedSandbox === true) && billable && developerId) {
      const { data: _dev } = await sb.from("developers")
        .select("calibration_status, impressions_calibrated, calibration_threshold")
        .eq("id", developerId).maybeSingle();
      if (_dev && _dev.calibration_status === "calibrating") {
        calibrating = true;
        if (event === "impression") {
          const _next = (_dev.impressions_calibrated || 0) + 1;
          await sb.from("developers").update({
            impressions_calibrated: _next,
            ...(_next >= (_dev.calibration_threshold || 1000) ? { calibration_status: "live" } : {}),
          }).eq("id", developerId);
        }
      }
    }
    if (!isSandbox && !(inheritedSandbox === true) && billable && !calibrating) {
      const { data: campaign } = await sb.from("campaigns")
        .select("billing_model, bid_amount, spent_today, spent_total, daily_budget, total_budget, conversion_event_types")
        .eq("id", campaignId).single();
      if (campaign) {
        // For CPA / CPI, the conversion_type must be in the campaign's
        // allowlist (or the allowlist is empty — meaning "any conversion
        // counts"). CPI defaults to {"install"} when no allowlist is set.
        let chargeable = true;
        if (event === "conversion") {
          const isAcqGoal = campaign.billing_model === "cpa" || campaign.billing_model === "cpi";
          if (!isAcqGoal) chargeable = false;
          else {
            const allow = Array.isArray(campaign.conversion_event_types)
              ? campaign.conversion_event_types : [];
            // CPI's default-allowlist is ["install"] when nothing's set —
            // the advertiser-side dashboard always seeds this on create
            // but we belt-and-suspenders here too.
            const effectiveAllow = (allow.length === 0 && campaign.billing_model === "cpi")
              ? ["install"] : allow;
            if (effectiveAllow.length > 0 && !effectiveAllow.includes(conversionType)) chargeable = false;
          }
        }
        const cost = chargeable ? computeCost(event, campaign) : 0;
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
    let { error } = await sb.from("events").insert(record);
    // Deploy-ordering resilience: if migration 19 hasn't been applied yet,
    // the events table has no context_hash column and PostgREST rejects the
    // whole insert (PGRST204). track.js is the billing artery — it must
    // never break on a code-before-migration deploy. Strip the new column
    // and retry once so impressions/clicks keep flowing until the migration
    // lands. Drop this guard after migration 19 is confirmed in production.
    if (error && error.code === "PGRST204" && /context_hash/.test(error.message || "")) {
      const { context_hash: _droppedCtx, ...legacyRecord } = record;
      ({ error } = await sb.from("events").insert(legacyRecord));
      res.setHeader("x-track-context-col-missing", "1");
    }
    if (error) {
      // 23505 = unique_violation. If the partial unique index fired between
      // our pre-check and the insert (race), treat as deduplication, not error.
      if (error.code === "23505") {
        res.setHeader("x-track-deduplicated", "race");
      } else {
        // Phase A — silent-failure observability. Structured log so Vercel
        // log search can grep `bbx:track:write_fail` and surface every
        // dropped beacon. Includes enough context to diagnose without PII.
        // Surfaced by Door 4 / Telegram validation 2026-05-08 — a uuid type
        // mismatch had been silently dropping every sandbox impression.
        console.error("bbx:track:write_fail", JSON.stringify({
          ts: new Date().toISOString(),
          tag: "track.write_fail",
          event_type:         record.event_type,
          campaign_id:        record.campaign_id,
          auction_id:         record.auction_id,
          integration_method: record.integration_method,
          is_sandbox:         record.is_sandbox,
          surface:            record.surface,
          format:             record.format,
          pg_code:            error.code || null,
          pg_message:         error.message || null,
          pg_details:         error.details || null,
        }));
        // Surface via response header too, so SDK callers that DO inspect
        // the response know something went wrong (most fire-and-forget,
        // but the JS Snippet's `data-debug` mode reads this).
        res.setHeader("x-track-write-failed", "1");
        res.setHeader("x-track-write-fail-code", String(error.code || "unknown"));
      }
    } else {
      // Phase E Day 2 — credit the publisher's balance after a clean
      // event insert. Skipped for sandbox traffic (we already gated cost
      // computation on !isSandbox + !inheritedSandbox upstream, so
      // developer_payout is 0 for sandbox events and creditPublisherBalance
      // no-ops on amount<=0 anyway — but we belt-and-suspenders the gate
      // here to keep the closed loop obvious to future readers).
      // ── Boost mint (free launch network) ──────────────────────────────
      // Every VERIFIED, non-sandbox impression the host serves mints +1 Boost
      // to the host — even for free (credit-funded) ads. This is the
      // "show one, get one shown" reciprocity that bootstraps the network.
      // Non-critical + deduped per (account, auction); never breaks track.
      if (record.event_type === "impression" && record.developer_id && !record.is_sandbox) {
        try { await boostCredits.mintBoost(sb, record.developer_id, 1, "serve", record.auction_id || null); }
        catch (_) { /* boosts are additive; never break the billing artery */ }
      }

      if (record.developer_payout > 0 && record.developer_id && !record.is_sandbox) {
        try {
          const credit = await publisherBalance.creditPublisherBalance(
            sb, record.developer_id, record.developer_payout,
          );
          if (credit.applied_to_clawbacks_usd > 0) {
            res.setHeader("x-publisher-clawback-applied",
              String(credit.applied_to_clawbacks_usd));
          }
          res.setHeader("x-publisher-credit-mode", credit.mode);
        } catch (e) {
          // Non-fatal — the event is recorded; balance is recoverable from
          // the events table (Decision 9 V2 rollup path). Log and move on.
          console.error("bbx:track:credit_fail", JSON.stringify({
            tag: "track.credit_fail",
            developer_id:    record.developer_id,
            developer_payout: record.developer_payout,
            campaign_id:     record.campaign_id,
            message:         e && e.message,
          }));
        }
      }
    }
  } else {
    // ── Demo path — compute cost and attribute to developer ──
    // Demo idempotency: scan the in-memory store for (auction_id, event_type).
    if (auctionId && DEMO_EVENTS.some((r) => r.auction_id === auctionId && r.event_type === event)) {
      res.setHeader("x-track-deduplicated", "1");
      if (req.method === "GET") return endGetBeacon();
      return res.json({
        tracked: true, deduplicated: true, event,
        campaign_id: campaignId, auction_id: auctionId,
      });
    }

    if (["impression", "click", "video_complete", "conversion"].includes(event)) {
      let campaign = null;
      try {
        // _DEMO_CAMPAIGNS is a Map in campaigns.js — use .get() not .find()
        const camps = require("./campaigns.js")._DEMO_CAMPAIGNS;
        if (camps && typeof camps.get === "function") campaign = camps.get(campaignId);
        else if (Array.isArray(camps)) campaign = camps.find(c => c.id === campaignId);
      } catch (_) {}
      if (campaign) {
        // Same CPA gating as the supabase path — only charge if the
        // campaign opted into CPA and the conversion_type matches.
        let chargeable = true;
        if (event === "conversion") {
          if (campaign.billing_model !== "cpa") chargeable = false;
          else {
            const allow = Array.isArray(campaign.conversion_event_types)
              ? campaign.conversion_event_types : [];
            if (allow.length > 0 && !allow.includes(conversionType)) chargeable = false;
          }
        }
        const cost = chargeable ? computeCost(event, campaign) : 0;
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

    // Phase E Day 2 — demo-path balance accrual. The publisher_balance
    // helper maintains an in-memory map mirroring the Supabase path so
    // tests covering the full credit+clawback flow can run without a DB.
    if (record.developer_payout > 0 && record.developer_id && !record.is_sandbox) {
      try {
        const credit = await publisherBalance.creditPublisherBalance(
          null, record.developer_id, record.developer_payout,
        );
        if (credit.applied_to_clawbacks_usd > 0) {
          res.setHeader("x-publisher-clawback-applied",
            String(credit.applied_to_clawbacks_usd));
        }
        res.setHeader("x-publisher-credit-mode", credit.mode);
      } catch (_) { /* non-fatal */ }
    }
  }

  // GET → a 1×1 pixel, or a 302 to `to` when set (Bot-door click redirect).
  if (req.method === "GET") return endGetBeacon();

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
  // CPA — Phase B. Charged when a matching conversion event lands. The
  // caller (track.js handler) is responsible for filtering against the
  // campaign's conversion_event_types allowlist before reaching here.
  if (event === "conversion" && campaign.billing_model === "cpa") {
    return campaign.bid_amount || 0;
  }
  // CPI — AI app user acquisition. Same cost mechanic as CPA but the
  // expected conversion event is 'install' (the publisher's user
  // completed installing/signing-up for the advertiser's AI app). The
  // billing_model split lets dashboards group by goal even though the
  // accounting math is identical.
  if (event === "conversion" && campaign.billing_model === "cpi") {
    return campaign.bid_amount || 0;
  }
  return 0;
}

// ── Exports for testing ─────────────────────────────────────────────────
module.exports.HAS_SUPABASE = HAS_SUPABASE;
module.exports._DEMO_EVENTS = DEMO_EVENTS;
module.exports._rateLimitMap = rateLimitMap;
module.exports._RATE_LIMIT_MAX = RATE_LIMIT_MAX;
module.exports._reset = function () {
  DEMO_EVENTS.length = 0;
  rateLimitMap.clear();
  // Phase E Day 2 — clear the in-memory publisher balance store too so
  // tests don't bleed into each other.
  publisherBalance._reset();
};
