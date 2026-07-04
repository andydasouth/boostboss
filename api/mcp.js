/**
 * Boost Boss — Lumi SDK MCP Server
 *
 * The JSON-RPC 2.0 endpoint that the @boostbossai/lumi-sdk talks to. Implements
 * the Model Context Protocol tools:
 *
 *   initialize                     → handshake (protocolVersion, capabilities)
 *   tools/list                     → enumerate get_sponsored_content, track_event
 *   tools/call · get_sponsored_content → Benna-scored first-price auction
 *   tools/call · track_event       → fire impression/click/close/skip/video_complete
 *
 * Two modes:
 *   • PRODUCTION — Supabase for campaigns + developer lookup
 *   • DEMO       — in-process campaign pool (same as rtb.js) so the
 *                  /demo.html playground and curl examples work without infra
 */

const benna = require("./benna.js");
const { mcpTargetingMatch, mintAuctionId } = require("./_lib/mcp_targeting.js");
const { lookupCachedEmbedding } = require("./_lib/embeddings.js");
const { isSandboxCredential, buildSandboxResponse } = require("./_lib/sandbox.js");
const auctionLog = require("./_lib/auction_log.js");
const { getCampaignHistoryBatch } = require("./_lib/campaign_history.js");
const { deriveContextHash, touchContextFingerprint } = require("./_lib/context.js");

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

// ── Demo campaign pool (shared with campaigns.js pattern) ──────────────
let _campaignsModule = null;
function demoCampaigns() {
  if (!_campaignsModule) {
    _campaignsModule = require("./campaigns.js");
    _campaignsModule._seed();
  }
  return [..._campaignsModule._DEMO_CAMPAIGNS.values()].filter(
    (c) => c.status === "active"
  );
}

// ── Demo events store ──────────────────────────────────────────────────
const DEMO_EVENTS = [];

// Rate limiting per session (3 min window)
const sessionCache = new Map();
const RATE_LIMIT_MS = 3 * 60 * 1000;

// ── Per-door creative resolver (Phase E.5 / migration 14) ──────────────
// Given a winning campaign and the door the auction came through, pick
// the right creative row. Cache by (campaign_id, door) for 60s so a
// hot campaign with a steady traffic mix only hits Supabase once a
// minute per door — the table is small and per-row, but auction is the
// hottest path in the system.
const _creativeCache = new Map(); // key: `${campaign_id}|${door}` → { row, until }
const CREATIVE_TTL_MS = 60 * 1000;

async function resolveCampaignCreative(campaignId, door) {
  if (!campaignId) return null;
  const allowedDoors = ["mcp", "js-snippet", "npm-sdk", "rest-api"];
  const wantedDoor = allowedDoors.includes(door) ? door : "default";
  const key = `${campaignId}|${wantedDoor}`;

  const now = Date.now();
  const cached = _creativeCache.get(key);
  if (cached && cached.until > now) return cached.row;

  let row = null;

  if (HAS_SUPABASE) {
    const sb = supa();
    if (sb) {
      // Pull the door-specific row + the 'default' fallback in one query.
      // Then pick the door-specific row if it exists, else the default.
      const { data } = await sb.from("campaign_creatives")
        .select("door, headline, subtext, media_url, poster_url, cta_label, cta_url")
        .eq("campaign_id", campaignId)
        .in("door", [wantedDoor, "default"]);
      if (Array.isArray(data) && data.length > 0) {
        row = data.find((r) => r.door === wantedDoor) || data.find((r) => r.door === "default") || null;
      }
    }
  } else {
    // Demo mode — read the in-memory _per_door_creatives off the
    // campaign object (set by api/campaigns.js handleCreate/handleUpdate).
    try {
      const camps = demoCampaigns();
      const c = camps.find((x) => String(x.id) === String(campaignId));
      const rows = (c && c._per_door_creatives) || [];
      row = rows.find((r) => r.door === wantedDoor) || rows.find((r) => r.door === "default") || null;
    } catch (_) { row = null; }
  }

  _creativeCache.set(key, { row, until: now + CREATIVE_TTL_MS });
  return row;
}

// Placement-tier → publisher format family. A campaign's placement_tier
// only clears the auction's tier gate if the publisher accepts at least
// one format in the matching family. See the tier gate in the filter chain.
const TIER_FAMILY = {
  "ai-native":    ["native"],
  "display":      ["image", "corner"],
  "interruptive": ["video", "fullscreen"],
};

// ── Server-side intent_tokens fallback ─────────────────────────────────
// When the publisher's door (JS Snippet via lumi.js, REST via
// /v1/ad-request) doesn't populate intent_tokens but DOES provide a
// context_summary, derive a token array from the summary so the cosine
// path can fire. Without this, intentMatchScore() collapses to neutral
// 1.0 for every campaign on those doors and the auction reduces to
// bid × geo × format with no semantic relevance — see the pre-launch
// audit (docs/benna-v1.md and intent_capture_reality memory).
//
// Light tokenisation: lowercase, split on non-alphanumeric, drop
// short tokens + English stopwords, dedupe, cap at 16 to bound the
// cache lookup cost. Per-language stopword lists are not used; the
// cache lookup itself is what filters useful tokens (a non-English
// stopword that misses the cache just doesn't contribute to the
// averaged vector).
const INTENT_STOPWORDS = new Set([
  "a","an","the","and","or","but","if","then","of","to","in","on",
  "for","with","is","are","was","were","be","been","being","have",
  "has","had","do","does","did","this","that","these","those","i",
  "you","he","she","it","we","they","my","your","our","their","at",
  "by","from","as","not","no","so","up","out","over","under","into",
  "than","just","like","get","gets","got","getting","make","makes",
  "made","making","need","needs","needed","want","wants","wanted",
  "can","could","will","would","should","about","what","which","who",
  "when","where","why","how",
]);
function deriveIntentTokensFromContext(text) {
  if (!text || typeof text !== "string") return [];
  const raw = text
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/);
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (t.length < 3) continue;
    if (INTENT_STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 16) break;
  }
  return out;
}

// ── Pilot model: pick one creative variant from a campaign's library ──
// See [[advertiser-pilot-model]]. After the 2026-06-24 correction, the
// Pilot model operates on real campaigns (not synthesized product
// boosts), so the auction pulls campaigns directly and this helper
// rotates among the variant arrays attached to each campaign.
//
// Deterministic within a time bucket so the same publisher request
// sees consistent copy within a session — but the variant rotates over
// time so Benna explores the variant space. boost_creative_refresh
// controls the bucket length (higher = shorter = faster rotation =
// more exploration). Future pass: replace with UCB1 multi-arm bandit
// reading per-variant CTR from auction_logs.
function pickCampaignVariant(campaignId, variants, salt, refreshSlider) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  if (variants.length === 1) return variants[0];
  const refresh = Number(refreshSlider);
  const refreshVal = Number.isFinite(refresh) ? refresh : 0.5;
  const bucketMinutes = Math.max(1, Math.round(15 - refreshVal * 14));  // 1..15 min
  const bucket = Math.floor(Date.now() / (bucketMinutes * 60 * 1000));
  const key = `${bucket}|${campaignId}|${salt}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return variants[Math.abs(h) % variants.length];
}

// ── Context derivation (MCP args → Benna bid context) ──────────────────
function deriveBennaContext(args) {
  const ctxText = (args.context_summary || "").toLowerCase();
  const out = {};

  if (/debug|error|exception|traceback|stack/.test(ctxText)) out.intent = "debug_py";
  else if (/doc|how to|tutorial|guide|reference/.test(ctxText)) out.intent = "docs_lookup";

  if (/run|exec|shell|terminal|bash/.test(ctxText)) out.mcp_tool = "shell.exec";
  else if (/read|open|view/.test(ctxText)) out.mcp_tool = "file.read";

  if (args.host) out.host = args.host;
  else if (/cursor/.test(ctxText)) out.host = "cursor.com";

  if (args.user_region) {
    const r = args.user_region.toLowerCase();
    out.region = r.includes("us") || r.includes("west") ? "us-west" : r;
  }

  if (args.session_len_min) out.session_len = args.session_len_min;

  // Pass-through MCP-native targeting fields from the request so scoreBid
  // can match against campaign.target_intent_tokens / target_active_tools /
  // target_host_apps / target_surfaces directly. Without this, only the
  // regex-derived single-value `intent` and `mcp_tool` reach scoreBid, and
  // requests with rich intent_tokens arrays only get partial scoring.
  // (Surfaced by Door 1 internal validation, 2026-05-01.)
  if (Array.isArray(args.intent_tokens))  out.intent_tokens  = args.intent_tokens;
  if (Array.isArray(args.active_tools))   out.active_tools   = args.active_tools;
  if (args.host_app)                      out.host_app       = args.host_app;
  if (args.surface)                       out.surface        = args.surface;

  return out;
}

// ── Self-promote host matching ─────────────────────────────────────────
// Normalizes a host string to its apex domain-ish form so that
// "www.fissbot.com", "https://fissbot.com/path", and "fissbot.com:443"
// all compare equal.
function normalizeHost(h) {
  if (!h) return null;
  try {
    // Accept both bare hosts and full URLs
    let s = String(h).trim().toLowerCase();
    if (!/^https?:\/\//.test(s)) s = "https://" + s;
    const u = new URL(s);
    return u.hostname.replace(/^www\./, "");
  } catch (_) { return null; }
}

// Returns true if the campaign belongs to the same "brand" as publisherHost.
// Checks the campaign.adomain array (preferred, advertiser-supplied) then
// falls back to the hostname of cta_url.
function campaignMatchesHost(campaign, publisherHost) {
  if (!publisherHost) return false;
  const candidates = [];
  for (const d of (campaign.adomain || [])) {
    const n = normalizeHost(d);
    if (n) candidates.push(n);
  }
  const ctaHost = normalizeHost(campaign.cta_url);
  if (ctaHost) candidates.push(ctaHost);
  // Match either direction of subdomain relationship so
  // fissbot.chat and fissbot.com both match fissbot.com.
  const baseOf = (h) => {
    const parts = h.split(".");
    return parts.length >= 2 ? parts.slice(-2).join(".") : h;
  };
  const pubBase = baseOf(publisherHost);
  return candidates.some((c) => baseOf(c) === pubBase);
}

// ── Eligibility filters ────────────────────────────────────────────────
function eligible(campaign, userRegion, userLanguage) {
  if ((campaign.spent_today || 0) >= (campaign.daily_budget || 0)) return false;
  if ((campaign.total_budget || 0) - (campaign.spent_total || 0) <= 0) return false;
  const regions = campaign.target_regions || ["global"];
  if (!regions.includes("global") && !regions.includes(userRegion)) return false;
  const langs = campaign.target_languages || ["en"];
  if (!langs.includes(userLanguage)) return false;
  return true;
}

function keywordContextBoost(campaign, ctxText) {
  const keywords = campaign.target_keywords || [];
  const ctx = (ctxText || "").toLowerCase();
  let hits = 0;
  for (const kw of keywords) if (ctx.includes(kw.toLowerCase())) hits++;
  return hits;
}

// MCP-native targeting helpers live in api/_lib/mcp_targeting.js so the
// OpenRTB path (api/rtb.js) and the JSON-RPC path here apply identical
// eligibility + scoring. See protocol §9.

// ────────────────────────────────────────────────────────────────────────
//                                HANDLER
// ────────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  // X-Lumi-Source needs to be in the allowed list because the JS snippet
  // sends it on bid requests; without it, browsers fail the CORS preflight.
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Lumi-Source");
  res.setHeader("x-mcp-mode", HAS_SUPABASE ? "supabase" : "demo");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};

  // Pull the integration_method from the X-Lumi-Source header (set by SDKs
  // and the JS snippet on every request). We bake it into the tracking
  // URLs returned by get_sponsored_content so the impression beacon
  // (a server-less GET from the browser) carries the source forward.
  const _lumiSource = String((req.headers && req.headers["x-lumi-source"]) || "")
    .toLowerCase().trim();
  const _validSources = ["mcp", "js-snippet", "npm-sdk", "rest-api"];
  const _integrationMethod = _validSources.includes(_lumiSource) ? _lumiSource : null;

  // ── initialize ──
  if (body.method === "initialize") {
    return res.json({
      jsonrpc: "2.0", id: body.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "boostboss-lumi-mcp",
          version: "1.0.0",
          description: "Boost Boss Lumi SDK — MCP Ad Server",
          url: "https://boostboss.ai",
        },
      },
    });
  }

  // ── tools/list ──
  if (body.method === "tools/list") {
    return res.json({
      jsonrpc: "2.0", id: body.id,
      result: {
        tools: [
          {
            name: "get_sponsored_content",
            description: "Get a contextually relevant sponsored recommendation matched to conversation context. Ads are ranked in real time by Benna AI using MCP signals (intent_tokens, active_tools, host, surface, session).",
            inputSchema: {
              type: "object",
              properties: {
                context_summary: { type: "string", description: "What the user is currently working on or asking about" },
                user_region:     { type: "string", description: "Region: US, EU, APAC, LATAM, global" },
                user_language:   { type: "string", description: "Language: en, zh, es, ja, ko" },
                session_id:      { type: "string", description: "Unique session ID" },
                developer_api_key: { type: "string", description: "Developer Lumi SDK API key" },
                format_preference: { type: "string", enum: ["image", "video", "native", "any"] },
                host:            { type: "string", description: "Host URL or app name (e.g., cursor.com or 'cursor')" },
                host_app:        { type: "string", description: "Canonical host-app name for targeting: cursor, claude_desktop, vscode, jetbrains" },
                session_len_min: { type: "number", description: "Minutes in-session — longer sessions signal stronger intent" },
                placement_id:    { type: "string", description: "Publisher's placement_id (e.g., plc_chat_inline_default). Enables placement-aware floor + freq cap." },
                surface:         { type: "string", enum: ["chat", "tool_response", "sidebar", "loading_screen", "status_line", "web"], description: "UI surface this impression is rendering into" },
                intent_tokens:   { type: "array", items: { type: "string" }, description: "Free-form intent strings, e.g. ['billing_integration','saas','stripe']" },
                active_tools:    { type: "array", items: { type: "string" }, description: "Canonical names of MCP servers connected in this session, e.g. ['stripe-mcp','quickbooks-mcp']" },
              },
              required: ["context_summary"],
            },
          },
          {
            name: "track_event",
            description: "Track ad event: impression, click, close, video_complete, skip, conversion. Pass auction_id from get_sponsored_content for idempotent (auction × event) recording. For conversion events, supply conversion_type + value (USD) + currency.",
            inputSchema: {
              type: "object",
              properties: {
                event:         { type: "string", enum: ["impression", "click", "close", "video_complete", "skip", "conversion"] },
                campaign_id:   { type: "string" },
                session_id:    { type: "string" },
                developer_api_key: { type: "string" },
                auction_id:    { type: "string", description: "Auction ID from get_sponsored_content; used as the idempotency key" },
                placement_id:  { type: "string", description: "Publisher placement_id; persisted on the events row" },
                surface:       { type: "string", description: "UI surface this impression rendered into" },
                format:        { type: "string", description: "Creative format actually rendered" },
                intent_match_score: { type: "number", description: "Benna intent-match score returned by get_sponsored_content" },
                // Conversion-specific fields (only populated when event === 'conversion')
                conversion_type: { type: "string", description: "What the conversion is for (signup, purchase, lead, tool_invoke, etc.)" },
                value:           { type: "number", description: "Conversion value in USD (e.g. 29.99 for a $29.99 purchase)" },
                currency:        { type: "string", description: "ISO 4217 currency code; default USD" },
                external_id:     { type: "string", description: "Advertiser's user/order id for cross-system reconciliation" },
              },
              required: ["event", "campaign_id"],
            },
          },
        ],
      },
    });
  }

  // ── tools/call ──
  if (body.method === "tools/call") {
    const toolName = body.params && body.params.name;
    const args = (body.params && body.params.arguments) || {};

    if (toolName === "get_sponsored_content") {
      // Forward integration_method into the tool args so handleGetSponsoredContent
      // can stamp it onto tracking URLs. Underscore prefix marks it as
      // SDK-derived rather than caller-supplied.
      if (_integrationMethod) args._integration_method = _integrationMethod;
      return await handleGetSponsoredContent(body, args, res);
    }
    if (toolName === "track_event") {
      return await handleTrackEvent(body, args, res);
    }
    return res.status(400).json({
      jsonrpc: "2.0", id: body.id,
      error: { code: -32601, message: `Unknown tool: ${toolName}` },
    });
  }

  return res.status(400).json({
    jsonrpc: "2.0", id: body.id || null,
    error: { code: -32601, message: `Unknown MCP method: ${body.method || "(none)"}` },
  });
};

// Per-placement publisher control (db/20_disabled_placements.sql). True when
// the publisher has switched the requested door-qualified placement off
// (the surface string: web-citation, ext-corner, mcp-card, bot-welcome, ...).
function placementDisabled(disabledList, surface) {
  return Array.isArray(disabledList) && !!surface && disabledList.indexOf(surface) !== -1;
}

// ── get_sponsored_content ───────────────────────────────────────────────
async function handleGetSponsoredContent(body, args, res) {
  const sessionId = args.session_id || "anon_" + Date.now();
  const auctionId = mintAuctionId();
  const t0 = Date.now();

  // ── Context fingerprint (capture now, score later) ─────────────────────
  // Derive a deterministic hash of the request context so every event this
  // auction produces — including no-fill — can be joined back to its
  // semantic context. The fingerprint upsert is fire-and-forget; the bid
  // path never waits on it. Benna stays a stub — this is pure capture.
  const contextHash = deriveContextHash(args.context_summary);
  if (contextHash) {
    touchContextFingerprint(supa(), {
      contextHash,
      contextText: args.context_summary,
      surface: args.surface || "mcp",
    }).catch(() => {});
  }

  // Auction log scaffold — mutated as the auction progresses, emitted at
  // every exit point. Logging is fire-and-forget; callers never await.
  const logCtx = {
    auction_id: auctionId,
    surface: "mcp",
    integration_method: args._integration_method || null,
    is_sandbox: false,
    request: {
      host: args.host,
      host_app: args.host_app,
      surface: args.surface,
      user_region: args.user_region,
      user_language: args.user_language,
      intent_tokens: args.intent_tokens,
      active_tools: args.active_tools,
      format_preference: args.format_preference,
      context_summary: args.context_summary,
      session_id: sessionId,
      placement_id: args.placement_id,
    },
    eligibility: {},
    candidates: [],
  };
  function emitLog(outcome, extras) {
    auctionLog.recordAuction({
      ...logCtx,
      ...(extras || {}),
      outcome,
      latency_ms: Date.now() - t0,
    });
  }

  // ── Sandbox short-circuit ───────────────────────────────────────────
  // pub_test_* / sk_test_* credentials skip the auction entirely and
  // get a fixed creative from a small rotation pool. Lets publishers
  // verify SDK integration end-to-end without signup, and gives a
  // predictable demo for outreach. Beacons fire to /api/track with
  // sandbox=1 so track.js short-circuits cost computation and tags
  // is_sandbox=true on the row. See api/_lib/sandbox.js.
  if (isSandboxCredential(args)) {
    const sandboxAuctionId = "auc_sandbox_" + auctionId.replace(/^auc_/, "");
    const base = (process.env.BOOSTBOSS_BASE_URL || "https://boostboss.ai").replace(/\/$/, "");
    emitLog("sandbox", { is_sandbox: true, auction_id: sandboxAuctionId });
    return jsonRpc(res, body.id, buildSandboxResponse({
      auctionId: sandboxAuctionId,
      base,
      sessionId,
      args,
    }));
  }

  // Rate limit
  const last = sessionCache.get(sessionId);
  if (last && Date.now() - last < RATE_LIMIT_MS) {
    emitLog("rate_limited", { no_fill_reason: "rate_limited" });
    return jsonRpc(res, body.id, { sponsored: null, reason: "rate_limited", auction_id: auctionId });
  }

  // ── Resolve placement (optional but recommended) ──
  // If the SDK passes a placement_id, we look it up to get its surface,
  // format, and floor_cpm. Without a placement_id we fall back to
  // request-level surface/format and a default floor (back-compat).
  const sb = supa();
  let placement = null;
  if (args.placement_id && sb) {
    const { data: p } = await sb.from("placements")
      .select("id,developer_id,surface,format,floor_cpm,freq_cap_per_user_per_day,excluded_categories,excluded_advertisers,status")
      .eq("id", args.placement_id).eq("status", "active").maybeSingle();
    if (p) placement = p;
  }
  const effectiveSurface = (placement && placement.surface) || args.surface || null;
  const effectiveFloor   = placement ? Number(placement.floor_cpm) : 0;

  // ── Frequency cap enforcement (placement-level, per anonymous_id, per day) ──
  // Skipped silently if the SDK didn't send anonymous_id (legacy callers)
  // or if there's no placement to read the cap from. Cap of 0 means "off".
  if (sb && placement && args.anonymous_id) {
    const cap = Number(placement.freq_cap_per_user_per_day) || 0;
    if (cap > 0) {
      const { data: capRow } = await sb.rpc("bbx_freq_cap_count", {
        p_anonymous_id: String(args.anonymous_id),
        p_placement_id: placement.id,
      });
      const seenToday = Number(capRow) || 0;
      if (seenToday >= cap) {
        emitLog("rate_limited", { no_fill_reason: "frequency_capped" });
        return jsonRpc(res, body.id, {
          sponsored: null,
          reason: "frequency_capped",
          auction_id: auctionId,
          frequency: { seen_today: seenToday, cap },
        });
      }
    }
  }

  // Load campaigns + product boosts. See [[advertiser-pilot-model]].
  // The Pilot model surfaces every active product as an auction candidate.
  // We coerce active boosts into the same shape the campaign filter +
  // scoring chain expects, marked with __is_pilot_boost=true so benna.js
  // and the win-tracking code below can apply slider modifiers and debit
  // boost_spent_cents on the winning product. Real campaigns and pilot
  // boosts compete in the same auction; whichever scores higher wins.
  let campaigns;
  if (sb) {
    // Active campaigns only. Per [[advertiser-pilot-model]] correction
    // 2026-06-24: campaigns themselves now carry boost_* fields (via
    // migration 31), so we no longer synthesize "virtual campaigns" from
    // products. The Pilot model operates directly on real campaign rows.
    const { data, error } = await sb.from("campaigns").select("*").eq("status", "active");
    if (error || !data || data.length === 0) {
      emitLog("no_match", { no_fill_reason: "no_campaigns", eligibility: { pool_size: 0 } });
      return jsonRpc(res, body.id, { sponsored: null, reason: "no_campaigns", auction_id: auctionId });
    }
    campaigns = data;
  } else {
    campaigns = demoCampaigns();
    if (campaigns.length === 0) {
      emitLog("no_match", { no_fill_reason: "no_campaigns", eligibility: { pool_size: 0 } });
      return jsonRpc(res, body.id, { sponsored: null, reason: "no_campaigns", auction_id: auctionId });
    }
  }

  // Resolve developer — and load their accepted-formats preferences.
  // Auction will filter out campaigns whose format this publisher rejects,
  // so publishers stay in control of their UX without writing code per-format.
  // Schema stores each format as an individual boolean column; we assemble
  // the preference object for the filter step.
  let developerId = null;
  let developerFormats = null; // null = no filter (accept all, back-compat)
  // Account-level brand-safety blocklists (db/18). Unioned with any
  // per-placement exclusions in the auction filter chain below.
  let developerBlockedCats = [];
  let developerBlockedDomains = [];
  if (args.developer_api_key && sb) {
    const { data: dev } = await sb.from("developers")
      .select("id, format_native, format_image, format_corner, format_video, format_fullscreen, blocked_categories, blocked_advertiser_domains, disabled_placements")
      .eq("api_key", args.developer_api_key).eq("status", "active").single();
    if (dev) {
      developerId = dev.id;
      // Per-placement publisher control (db/20_disabled_placements.sql).
      // The four-door SDKs send a door-qualified surface (web-citation,
      // ext-corner, mcp-card, bot-welcome...); if the publisher switched
      // that placement off in the dashboard, no-fill before the auction.
      if (placementDisabled(dev.disabled_placements, args.surface)) {
        emitLog("no_match", { no_fill_reason: "placement_disabled" });
        return jsonRpc(res, body.id, {
          sponsored: null, reason: "placement_disabled", auction_id: auctionId,
        });
      }
      developerFormats = {
        native:     dev.format_native !== false,
        image:      dev.format_image !== false,
        corner:     dev.format_corner !== false,
        video:      dev.format_video !== false,
        fullscreen: dev.format_fullscreen !== false,
      };
      developerBlockedCats    = Array.isArray(dev.blocked_categories) ? dev.blocked_categories : [];
      developerBlockedDomains = Array.isArray(dev.blocked_advertiser_domains) ? dev.blocked_advertiser_domains : [];
    }
  }

  // Benna-powered first-price auction
  const region = args.user_region || "global";
  const lang = args.user_language || "en";
  const bennaCtx = deriveBennaContext(args);

  // Self-promote: if the publisher host matches the advertiser's own domain,
  // the advertiser's campaign wins automatically (house ad / fallback).
  // Every publisher who is also an advertiser wants this — it fills inventory
  // other advertisers wouldn't bid on, and lets you test your own ads on your
  // own product without gaming the auction.
  const publisherHost = normalizeHost(args.host);

  // MCP targeting context derived from request args (and placement if present).
  const mcpCtx = {
    surface:      effectiveSurface,
    host_app:     args.host_app || null,
    active_tools: Array.isArray(args.active_tools) ? args.active_tools : [],
  };
  const reqIntentTokens = Array.isArray(args.intent_tokens) ? args.intent_tokens : [];

  // Door-fallback intent derivation: if the request didn't carry an
  // explicit intent_tokens array (JS Snippet via lumi.js, REST via
  // /v1/ad-request both omit it) but DID carry a context_summary,
  // tokenise the summary so the cosine path has something to look
  // up. This is the door-unifying fix from the 2026-06-15 audit —
  // without it, three of the four doors collapse to neutral 1.0
  // intent_match_score and the auction loses all semantic relevance.
  const derivedIntentTokens = reqIntentTokens.length === 0
    ? deriveIntentTokensFromContext(args.context_summary)
    : [];

  // Look up cached per-token embeddings via a single indexed Postgres
  // query, average the hit vectors, and use that as the request-side
  // context vector. NO OpenAI calls in the hot path — any tokens that
  // miss the cache are logged async into intent_embedding_misses and
  // picked up by /api/embed-cron on the next tick. Returns null when
  // every token misses → Benna falls back to Jaccard.
  const requestEmbedding = await lookupCachedEmbedding([
    ...reqIntentTokens,
    ...derivedIntentTokens,
    ...(mcpCtx.active_tools || []).map((t) => t.replace(/-mcp$/, "")),
    ...(mcpCtx.host_app ? [mcpCtx.host_app] : []),
    ...(effectiveSurface ? [effectiveSurface] : []),
  ]);

  // Make derived tokens available to downstream Jaccard fallback too —
  // when the cosine path can't fire (cache cold, embeddings null),
  // Benna's intentMatchScore() Jaccards over token ARRAYS. If we only
  // populated the cache lookup but didn't surface the derived tokens
  // to scorePrice(), the Jaccard branch would still see an empty
  // request-side array and collapse to neutral 1.0. Concatenating
  // derivedIntentTokens into reqIntentTokens fixes both code paths.
  const effectiveIntentTokens = reqIntentTokens.length > 0
    ? reqIntentTokens
    : derivedIntentTokens;

  // Publisher-side brand-safety: refuse advertiser categories the publisher excluded.
  // Brand-safety exclusions = per-placement exclusions ∪ the publisher's
  // account-level blocklists (db/18). The auction's afterBlocklistCat /
  // afterBlocklistAdv steps below enforce both in one pass.
  const excludedCats = [
    ...((placement && placement.excluded_categories) || []),
    ...developerBlockedCats,
  ];
  const excludedAdv  = [
    ...((placement && placement.excluded_advertisers) || []),
    ...developerBlockedDomains,
  ];
  const overlapsArr  = (a, b) => Array.isArray(a) && Array.isArray(b)
    && a.some((x) => b.includes(x));

  // Build the placement context that scorePrice() needs. When no placement
  // was supplied we synthesize one from the request args + format defaults
  // so the protocol §9 multipliers (geo / format / safety) still apply.
  const scorePlacement = placement || {
    surface: effectiveSurface,
    format:  null,
    floor_cpm: 0,
    excluded_categories: [],
    excluded_advertisers: [],
    baseline_ctr: 1.0,
  };

  // Country code for geo_multiplier — Benna expects ISO-3166-1 alpha-2.
  const countryCode = (args.user_region || "").toUpperCase().slice(0, 2) || null;

  // Per-stage eligibility filtering — each step's count is captured into
  // logCtx.eligibility so the dashboard can answer "which filter dropped
  // my campaign?" without re-running the auction. Identical semantics to
  // the original chained filters; just split for instrumentation.
  const afterEligible        = campaigns.filter((c) => eligible(c, region, lang));
  const afterFormatToggle    = afterEligible.filter((c) => {
    if (!developerFormats) return true;
    const fmt = c.format || "native";
    return developerFormats[fmt] !== false;
  });
  // Tier gate — a campaign with a placement_tier only competes if the
  // publisher has at least one format from that tier's family switched on
  // (ai-native=native, display=image|corner, interruptive=video|fullscreen).
  // NULL tier, or no publisher format prefs = unrestricted (back-compat).
  const afterTierGate        = afterFormatToggle.filter((c) => {
    if (!c.placement_tier || !developerFormats) return true;
    const fams = TIER_FAMILY[c.placement_tier];
    if (!fams) return true;
    return fams.some((f) => developerFormats[f] !== false);
  });
  const afterPlacementFormat = afterTierGate.filter((c) => !placement || (c.format || "native") === placement.format);
  const afterBlocklistCat    = afterPlacementFormat.filter((c) => !overlapsArr(c.iab_cat, excludedCats));
  const afterBlocklistAdv    = afterBlocklistCat.filter((c) => !overlapsArr(c.adomain, excludedAdv));
  // Door filter — campaigns can opt into specific publisher integration
  // doors via target_integration_methods (db/09_target_integration_methods.sql).
  // Empty array means "all doors" — every existing campaign passes through
  // unchanged. When set, the request's integration_method (from the
  // X-Lumi-Source header) must be in the campaign's allowlist. If the
  // request has no integration_method (legacy / untagged), the campaign
  // is excluded from the campaign's allowlist set rather than served — the
  // advertiser explicitly opted in to a door, so untagged traffic falls
  // through to other campaigns.
  const reqMethod = args._integration_method || null;
  const afterDoor = afterBlocklistAdv.filter((c) => {
    const allowed = Array.isArray(c.target_integration_methods) ? c.target_integration_methods : [];
    if (allowed.length === 0) return true;
    return reqMethod != null && allowed.includes(reqMethod);
  });
  const afterMcp             = afterDoor.filter((c) => mcpTargetingMatch(c, mcpCtx));

  // Phase C — batch-fetch 7-day history for every candidate campaign in a
  // single SQL round-trip (in-process cached for 5 min, see
  // api/_lib/campaign_history.js). Both scoreBid and scorePrice consume
  // the result to apply observed-CTR modifiers. Campaigns with <100 imps
  // get a learning-phase fallback; campaigns warmed up shift Benna's
  // bid in line with real performance instead of pure targeting overlap.
  const historyMap = await getCampaignHistoryBatch(sb, afterMcp.map((c) => c.id));

  const candidatesScored = afterMcp.map((c) => {
      const cHistory = historyMap.get(c.id) || null;
      // p_click / p_convert / signal_contributions for the dashboard
      // "Why did this win" panel. scoreBid() reads the campaign's actual
      // target_* columns to compute per-signal contributions; scorePrice()
      // (below) handles the §9 auction pricing.
      const prediction = benna.scoreBid(bennaCtx, {
        id: c.id,
        target_cpa: c.target_cpa || c.bid_amount || 4.5,
        goal: c.optimization_goal || "target_cpa",
        format: c.format,
        target_intent_tokens: c.target_intent_tokens || [],
        target_active_tools: c.target_active_tools || [],
        target_host_apps:    c.target_host_apps    || [],
        target_surfaces:     c.target_surfaces     || [],
        target_keywords:     c.target_keywords     || [],
        // Pilot model — pass through the campaign's own boost_* columns
        // (migration 31). benna.js reads these directly; no virtual-
        // campaign synthesis layer anymore. See [[advertiser-pilot-model]].
        boost_objective:        c.boost_objective,
        boost_pacing:           c.boost_pacing,
        boost_reach:            c.boost_reach,
        boost_brand_safety:     c.boost_brand_safety,
        boost_creative_refresh: c.boost_creative_refresh,
        boost_confidence_floor: c.boost_confidence_floor,
      }, cHistory);
      const priced = benna.scorePrice({
        placement: scorePlacement,
        context: {
          // effectiveIntentTokens = reqIntentTokens when the publisher
          // provided them, else the server-derived tokens from
          // context_summary. Feeding this to the Jaccard fallback (not
          // just to the cosine cache lookup) means JS Snippet / REST
          // doors get real semantic ranking even when the cache is
          // cold or campaign embeddings haven't been computed yet.
          intent_tokens: effectiveIntentTokens,
          country: countryCode,
          host_app: mcpCtx.host_app,
        },
        campaign: {
          bid_amount: c.bid_amount,
          format: c.format,
          target_intent_tokens: c.target_intent_tokens || [],
          intent_embedding: c.intent_embedding || null,
          iab_cat: c.iab_cat || [],
          adomain: c.adomain || [],
        },
        // Hot-path cosine path. When BOTH this AND campaign.intent_embedding
        // are non-null, intentMatchScore() uses cosine similarity instead
        // of Jaccard, which produces real semantic variance.
        request_intent_embedding: requestEmbedding,
        history: cHistory,
      });
      const kwBoost = keywordContextBoost(c, args.context_summary);
      // Apply the keyword-context heuristic on top of the §9 price as a
      // small bonus so the existing demo behaviour (target_keywords matches)
      // still nudges things — once embeddings ship we can drop this.
      const effective_price_cpm = priced.price_cpm * (1 + kwBoost * 0.15);
      const selfPromote = publisherHost && campaignMatchesHost(c, publisherHost);
      return { c, prediction, priced, kwBoost, effective_price_cpm, selfPromote };
    });

  // Floor enforcement: drop bids that didn't clear the placement floor.
  // Self-promote bypasses the floor (house ad always allowed to fill).
  const scored = candidatesScored
    .filter((x) => x.effective_price_cpm > 0 && (x.selfPromote || x.effective_price_cpm >= effectiveFloor))
    // Ranking: (1) self-promote (house ad) first, (2) CASH-funded promotions
    // outrank free CREDIT/Boost-funded ones — paying cash is the amplification
    // tier of the free launch network; free credit promos fill the remainder,
    // (3) among equals, highest effective CPM wins.
    .sort((a, b) => {
      if (a.selfPromote !== b.selfPromote) return a.selfPromote ? -1 : 1;
      const aCash = !(a.c && a.c.credit_funded === true);
      const bCash = !(b.c && b.c.credit_funded === true);
      if (aCash !== bCash) return aCash ? -1 : 1;
      return b.effective_price_cpm - a.effective_price_cpm;
    });

  // Materialize eligibility breakdown + candidates snapshot for the log.
  const winnerObj = scored[0] || null;
  logCtx.eligibility = {
    pool_size:              campaigns.length,
    after_eligible:         afterEligible.length,
    after_format_toggle:    afterFormatToggle.length,
    after_tier_gate:        afterTierGate.length,
    after_placement_format: afterPlacementFormat.length,
    after_blocklist_cat:    afterBlocklistCat.length,
    after_blocklist_adv:    afterBlocklistAdv.length,
    after_door:             afterDoor.length,
    after_mcp:              afterMcp.length,
    after_floor:            scored.length,
    drop_reasons: {
      eligible:         campaigns.length            - afterEligible.length,
      format_toggle:    afterEligible.length        - afterFormatToggle.length,
      tier_gate:        afterFormatToggle.length    - afterTierGate.length,
      placement_format: afterTierGate.length        - afterPlacementFormat.length,
      blocklist_cat:    afterPlacementFormat.length - afterBlocklistCat.length,
      blocklist_adv:    afterBlocklistCat.length    - afterBlocklistAdv.length,
      door:             afterBlocklistAdv.length    - afterDoor.length,
      mcp:              afterDoor.length            - afterMcp.length,
      floor:            candidatesScored.length     - scored.length,
    },
  };
  logCtx.candidates = candidatesScored.map((x) => ({
    campaign_id:         x.c.id,
    campaign_name:       x.c.name,
    p_click:             x.prediction.p_click,
    p_convert:           x.prediction.p_convert,
    signal_contributions: x.prediction.signal_contributions,
    price_cpm:           x.priced.price_cpm,
    factors:             x.priced.factors,
    kw_boost:            x.kwBoost,
    effective_price_cpm: x.effective_price_cpm,
    self_promote:        x.selfPromote,
    won:                 winnerObj === x,
  }));
  // Resolve publisher fields for the log (best-effort; never block auction)
  logCtx.publisher_id = developerId || null;
  logCtx.publisher_domain = publisherHost || null;

  if (scored.length === 0) {
    const reason = effectiveFloor > 0 ? "below_floor" : "no_match";
    emitLog(reason === "below_floor" ? "below_floor" : "no_match", { no_fill_reason: reason });
    return jsonRpc(res, body.id, { sponsored: null, reason, auction_id: auctionId });
  }

  const winner = scored[0];
  const w = winner.c;
  const p = winner.prediction;
  sessionCache.set(sessionId, Date.now());

  // ── Pilot model: bandit creative pick + spend debit ──────────────
  // Inheritance order per [[advertiser-pilot-model]] 2026-06-25:
  //   1. campaign.creative_* variant arrays (per-campaign override)
  //   2. advertiser's global creative_assets row (the Creatives sidebar
  //      library — single source of truth across 37 placements)
  //   3. campaign's legacy single headline/subtext/cta_label fields
  //
  // The library row is fetched lazily — only after the auction has a
  // winner, so the cost is one extra Supabase call per won auction
  // (not per candidate). Best-effort: if it fails or the row doesn't
  // exist yet, we silently fall through to (1) or (3).
  let assetsRow = null;
  if (sb && w.advertiser_id) {
    try {
      const { data: aRow } = await sb
        .from("creative_assets")
        .select("*")
        .eq("advertiser_id", w.advertiser_id)
        .maybeSingle();
      if (aRow) assetsRow = aRow;
    } catch (_) { /* never block the auction on the library fetch */ }
  }

  // Map placement.format → which library length to pull from.
  //   text_card  → *_short   (chips, citations — ≤30 char headlines, ≤80 body)
  //   native     → *_medium  (cards, hero, splash — ≤55 char headlines, ≤140 body)
  //   image      → *_short   (optional overlay only; the image carries the message)
  //   video      → *_medium  (rendered on the endcard, after video completes)
  function lengthSlotForFormat(fmt) {
    switch (fmt) {
      case "text_card": return "short";
      case "native":    return "medium";
      case "image":     return "short";
      case "video":     return "medium";
      default:          return "medium";
    }
  }
  function libraryArrayFor(kind, lenSlot) {
    if (!assetsRow) return null;
    const key = kind + "_" + lenSlot;  // 'headlines_medium', 'body_short', etc.
    const arr = assetsRow[key];
    if (Array.isArray(arr) && arr.length > 0) return arr;
    return null;
  }
  function effectiveVariants(campaignArr, libraryKind, lenSlot) {
    // Campaign array wins if populated. Otherwise pull from library.
    if (Array.isArray(campaignArr) && campaignArr.length > 0) return campaignArr;
    return libraryArrayFor(libraryKind, lenSlot) || null;
  }

  const lenSlot = lengthSlotForFormat(w.format);
  const headVariants = effectiveVariants(w.creative_headlines, "headlines", lenSlot);
  const bodyVariants = effectiveVariants(w.creative_body_copy,  "body",      lenSlot);
  // CTAs are length-agnostic in the library (just cta_labels).
  const ctaVariants  = (Array.isArray(w.creative_cta_labels) && w.creative_cta_labels.length > 0)
    ? w.creative_cta_labels
    : (assetsRow && Array.isArray(assetsRow.cta_labels) && assetsRow.cta_labels.length > 0
        ? assetsRow.cta_labels
        : null);

  if (headVariants) {
    const pickedHead = pickCampaignVariant(w.id, headVariants, "head", w.boost_creative_refresh);
    if (pickedHead) w.headline = pickedHead;
  }
  if (bodyVariants) {
    const pickedBody = pickCampaignVariant(w.id, bodyVariants, "body", w.boost_creative_refresh);
    if (pickedBody) w.subtext = pickedBody;
  }
  if (ctaVariants) {
    const pickedCta = pickCampaignVariant(w.id, ctaVariants, "cta", w.boost_creative_refresh);
    if (pickedCta) w.cta_label = pickedCta;
  }

  // Image fallback: if the campaign has no media_url, pull a library
  // image of the aspect ratio that best matches the placement.kind.
  // Benna rotates among multiple library images using the same bucketed
  // hash as the text variants.
  if (!w.media_url && assetsRow && placement && placement.kind) {
    const ASPECT_BY_KIND = {
      // 16:9 landscape — the workhorse aspect
      "corner":                "images_16_9",
      "card":                  "images_16_9",
      "hero":                  "images_16_9",
      "loading":               "images_16_9",
      "new_tab":               "images_16_9",
      "splash_sponsor":        "images_16_9",
      "popup_card":            "images_16_9",
      "side_panel":            "images_16_9",
      "install_onboarding":    "images_16_9",
      "settings":              "images_16_9",
      "sidebar":               "images_16_9",
      "inline_native_banner":  "images_16_9",
      "inline_sponsored_card": "images_16_9",
      "loading_state_ad":      "images_16_9",
      // 9:16 portrait — mobile vertical
      "interstitial":          "images_9_16",
      // 3:1 banner — narrow status surfaces
      "bottom_banner":         "images_3_1",
      "window_banner":         "images_3_1",
      "system_notification":   "images_3_1",
    };
    const aspectKey = ASPECT_BY_KIND[placement.kind] || "images_16_9";
    const imgs = assetsRow[aspectKey];
    if (Array.isArray(imgs) && imgs.length > 0) {
      const picked = pickCampaignVariant(w.id, imgs, "img", w.boost_creative_refresh);
      if (picked) w.media_url = picked;
    }
  }

  // Video fallback: only used when format=video. Pick orientation by
  // placement.kind hint (rewarded_video / pre_roll_video default landscape).
  if (!w.media_url && w.format === "video" && assetsRow) {
    const portraitKind = (placement && /portrait|vertical|9_16/.test(placement.kind || ""));
    w.media_url  = portraitKind ? (assetsRow.video_portrait_url || assetsRow.video_landscape_url)
                                : (assetsRow.video_landscape_url || assetsRow.video_portrait_url);
    if (!w.poster_url) w.poster_url = assetsRow.video_poster_url || null;
  }

  // Spend debit — campaign won, charge against campaigns.spent_total via
  // the increment_boost_spend RPC. Auto-deplete on total_budget cap.
  // effective_price_cpm is USD per 1000 impressions; this impression
  // costs effective_price_cpm / 1000 USD (so × 100 = cents).
  if (sb && w.id) {
    const cpm = Number(winner.effective_price_cpm) || (winner.priced && Number(winner.priced.price_cpm)) || 0;
    const debitCents = Math.max(0, Math.round(cpm * 0.1));  // (cpm / 1000) × 100
    if (debitCents > 0) {
      sb.rpc("increment_boost_spend", {
        p_campaign_id: w.id,
        p_cents:       debitCents,
      }).then(() => {}, (err) => {
        console.warn("[pilot] boost_spend debit failed:", err && err.message);
      });
    }
  }

  // Phase E.5 — resolve per-door creative override.
  // If the advertiser supplied door-specific copy via the
  // campaign_creatives table (migration 14), prefer that row; otherwise
  // fall back to the campaign's 'default' row; otherwise fall back to
  // the legacy fields on the campaign itself (or the variant we just
  // rotated in above). We override `w`'s creative-shaped fields in-place
  // so the rest of the response builder doesn't need to know about the
  // table.
  {
    const doorForCreative = args._integration_method || "default";
    const creative = await resolveCampaignCreative(w.id, doorForCreative);
    if (creative) {
      if (creative.headline)    w.headline   = creative.headline;
      if (creative.subtext)     w.subtext    = creative.subtext;
      if (creative.media_url)   w.media_url  = creative.media_url;
      if (creative.poster_url)  w.poster_url = creative.poster_url;
      if (creative.cta_label)   w.cta_label  = creative.cta_label;
      if (creative.cta_url)     w.cta_url    = creative.cta_url;
    }
  }

  const base = process.env.BOOSTBOSS_BASE_URL || "https://boostboss.ai";
  // Auction-keyed tracking URLs. /api/track will use (auction_id, event_type)
  // as the idempotency key (events_auction_type_unique partial index, see
  // db/04_bbx_mcp_extensions.sql §3).
  const trackParams = new URLSearchParams({
    campaign_id: String(w.id),
    session: sessionId,
    dev: developerId || "",
    auction: auctionId,
  });
  if (placement && placement.id) trackParams.set("placement", placement.id);
  if (effectiveSurface)          trackParams.set("surface", effectiveSurface);
  if (w.format)                  trackParams.set("format", String(w.format));
  // Context fingerprint — joins every event from this auction back to the
  // semantic context that produced it (db/19_context_fingerprints.sql).
  if (contextHash)               trackParams.set("ctx", contextHash);
  const ims = winner.priced && winner.priced.factors && winner.priced.factors.intent_match_score;
  if (Number.isFinite(ims)) {
    trackParams.set("ims", ims.toFixed(4));
  }
  // Bake integration_method (from X-Lumi-Source header) into the tracking
  // URL so the GET-based impression beacon carries the source forward
  // when track.js writes the events row. db/06_integration_method.sql.
  if (args._integration_method) trackParams.set("integration_method", args._integration_method);
  const track = `${base}/api/track?${trackParams.toString()}`;

  // Append bbx_auc to the cta_url so the advertiser's conversion pixel
  // can attribute the conversion back to this auction (protocol §5).
  // Existing query string is preserved; we just tack on bbx_auc=...
  // (and bbx_cmp= for clean dashboards). url_template macros from the
  // bidder_response would replace this once external bidders ship.
  function appendQuery(url, k, v) {
    if (!url) return url;
    const sep = url.includes("?") ? "&" : "?";
    return url + sep + encodeURIComponent(k) + "=" + encodeURIComponent(v);
  }
  let ctaUrl = w.cta_url || "";
  ctaUrl = appendQuery(ctaUrl, "bbx_auc", auctionId);
  ctaUrl = appendQuery(ctaUrl, "bbx_cmp", String(w.id));

  emitLog("won", {
    winner_campaign_id: String(w.id),
    winning_price_cpm: +winner.effective_price_cpm.toFixed(4),
  });

  // ── Brand kit + voucher — pulled from the global creative_assets row
  // for the winning campaign's advertiser. Additive to the sponsored
  // payload; SDKs render "sponsored by [brand]" lines with logos when
  // present, and the voucher endcard on rewarded/interstitial formats.
  const brandKit = assetsRow ? {
    name:        assetsRow.brand_name        || null,
    logo_url:    assetsRow.brand_logo_url    || null,
    favicon_url: assetsRow.brand_favicon_url || null,
    color:       assetsRow.brand_color       || null,
    domain:      assetsRow.brand_domain      || null,
  } : null;
  const voucher = (assetsRow && assetsRow.voucher_value_text) ? {
    value_text:       assetsRow.voucher_value_text,
    code:             assetsRow.voucher_code             || null,
    redemption_url:   assetsRow.voucher_redemption_url   || null,
  } : null;

  return jsonRpc(res, body.id, {
    sponsored: {
      campaign_id: w.id,
      type: w.format,
      headline: w.headline,
      subtext: w.subtext,
      media_url: w.media_url,
      poster_url: w.poster_url || null,
      cta_label: w.cta_label,
      cta_url: ctaUrl,
      skippable_after_sec: w.skippable_after_sec || 3,
      // Library-sourced extras — null when the advertiser hasn't filled
      // their /creatives library yet. SDKs should treat these as optional.
      brand_kit: brandKit,
      voucher:   voucher,
      tracking: {
        impression:     `${track}&event=impression`,
        click:          `${track}&event=click`,
        close:          `${track}&event=close`,
        skip:           `${track}&event=skip`,
        dismiss:        `${track}&event=dismiss`,
        video_complete: `${track}&event=video_complete`,
      },
    },
    auction: {
      auction_id: auctionId,
      placement_id: placement ? placement.id : null,
      surface: effectiveSurface,
      format: w.format,
      floor_cpm: effectiveFloor || null,
      winning_price_cpm: +winner.effective_price_cpm.toFixed(4),
      intent_match_score: winner.priced.factors.intent_match_score,
      candidates_considered: scored.length,
      // Protocol §9 factor breakdown — what each multiplier contributed
      // to the winning price. Used by the advertiser dashboard's "why
      // did this campaign win" panel.
      price_breakdown: winner.priced.factors,
    },
    benna: {
      model_version: p.model_version,
      // Legacy fields (kept so the existing dashboard panels render)
      bid_usd: p.bid_usd,
      effective_bid_usd: +(winner.effective_price_cpm / 1000).toFixed(6),
      p_click: p.p_click,
      p_convert: p.p_convert,
      signal_contributions: p.signal_contributions,
      // §9 fields
      price_cpm: +winner.effective_price_cpm.toFixed(4),
      cleared_floor: winner.priced.cleared_floor,
      latency_ms: p.latency_ms,
      candidates_considered: scored.length,
      context: bennaCtx,
      mcp_targeting: {
        surface:       effectiveSurface,
        host_app:      mcpCtx.host_app,
        active_tools:  mcpCtx.active_tools,
        intent_tokens: effectiveIntentTokens,
        // Flag whether tokens were publisher-supplied or server-derived
        // from context_summary. Lets the dashboard show "Intent: derived
        // from page context" vs "Intent: publisher-supplied" honestly.
        intent_tokens_derived: reqIntentTokens.length === 0 && derivedIntentTokens.length > 0,
      },
      self_promote: !!winner.selfPromote,
    },
  });
}

// ── track_event ─────────────────────────────────────────────────────────
// Delegates to the track API handler so cost computation, budget deduction,
// and auto-pause all happen consistently whether the event comes from the
// SDK pixel or the MCP tool call.
async function handleTrackEvent(body, args, res) {
  const trackHandler = require("./track.js");
  const mockRes = {
    _status: 200, _body: null, _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(n) { this._status = n; return this; },
    json(o) { this._body = o; return this; },
    send(d) { this._body = d; return this; },
    end() { return this; },
  };
  // 2026-05-20 — detect sandbox impressions by the campaign_id prefix.
  // Sandbox creatives live in api/_lib/sandbox.js (cmp_sandbox_*), not in
  // the campaigns table. track.js skips the "campaign exists" validation
  // when params.sandbox === "1"; without that flag, sandbox impressions
  // 404 with "Campaign not found." Also honour an explicit args.sandbox
  // flag if a future SDK ever passes it.
  const isSandboxCampaign =
    args.sandbox === 1 || args.sandbox === "1" || args.sandbox === true ||
    (typeof args.campaign_id === "string" && args.campaign_id.startsWith("cmp_sandbox_"));

  const mockReq = {
    method: "POST",
    // Tag every impression/click coming through MCP with integration_method='mcp'
    // so the dashboard can slice by source. db/06_integration_method.sql.
    headers: { "x-lumi-source": "mcp" },
    query: {},
    body: {
      event: args.event,
      campaign_id: args.campaign_id,
      session_id: args.session_id || null,
      developer_id: args.developer_api_key || null,
      // Auction-keyed fields per protocol §6 (events_auction_type_unique
      // idempotency index). All optional — track.js handles missing values.
      auction_id:   args.auction_id || null,
      placement_id: args.placement_id || null,
      surface:      args.surface || null,
      format:       args.format || null,
      intent_match_score: args.intent_match_score != null ? Number(args.intent_match_score) : null,
      // Sandbox flag — only forwarded when the campaign_id pattern matches.
      // Real impressions never get this; their campaign_id will resolve in
      // the campaigns table and the validation passes naturally.
      sandbox: isSandboxCampaign ? "1" : undefined,
      // Conversion-specific fields (Phase B). Forwarded only when present;
      // track.js no-ops them for non-conversion events. value is USD dollars
      // on the wire — track.js converts to cents for storage.
      conversion_type: args.conversion_type || null,
      value:           args.value != null ? Number(args.value) : null,
      currency:        args.currency || null,
      external_id:     args.external_id || null,
    },
  };
  let trackErr = null;
  try {
    await trackHandler(mockReq, mockRes);
  } catch (e) {
    trackErr = e.message;
    console.error("[MCP track_event]", e.message);
  }
  // Forward track's diagnostic headers so callers can see if the
  // api_key→UUID resolution succeeded, the key type used, etc. Before
  // this, these were set on the mock response and discarded — silent
  // insert failures were invisible from outside.
  for (const [k, v] of Object.entries(mockRes._headers || {})) {
    if (k.toLowerCase().startsWith("x-track-")) res.setHeader(k, v);
  }
  // Also store in MCP's local events for the test suite
  DEMO_EVENTS.push({
    event_type: args.event,
    campaign_id: args.campaign_id,
    session_id: args.session_id || null,
    created_at: new Date().toISOString(),
  });
  // Return the REAL outcome instead of always {tracked:true}. Publishers
  // (and the E2E test) need to see when an insert fails.
  const ok = !trackErr && mockRes._status < 400;
  return jsonRpc(res, body.id, {
    tracked: ok,
    ...(ok ? {} : { error: (mockRes._body && mockRes._body.error) || trackErr || `HTTP ${mockRes._status}` }),
    ...(mockRes._headers["x-track-dev-resolved"] ? { dev_resolved: mockRes._headers["x-track-dev-resolved"] } : {}),
  });
}

function jsonRpc(res, id, result) {
  return res.json({
    jsonrpc: "2.0", id,
    result: { content: [{ type: "text", text: JSON.stringify(result) }] },
  });
}

// ── Exports for testing ─────────────────────────────────────────────────
module.exports.HAS_SUPABASE = HAS_SUPABASE;
module.exports.placementDisabled = placementDisabled;
module.exports._DEMO_EVENTS = DEMO_EVENTS;
module.exports._reset = function () {
  DEMO_EVENTS.length = 0;
  sessionCache.clear();
};
