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
            description: "Track ad event: impression, click, close, video_complete, skip. Pass auction_id from get_sponsored_content for idempotent (auction × event) recording.",
            inputSchema: {
              type: "object",
              properties: {
                event:         { type: "string", enum: ["impression", "click", "close", "video_complete", "skip"] },
                campaign_id:   { type: "string" },
                session_id:    { type: "string" },
                developer_api_key: { type: "string" },
                auction_id:    { type: "string", description: "Auction ID from get_sponsored_content; used as the idempotency key" },
                placement_id:  { type: "string", description: "Publisher placement_id; persisted on the events row" },
                surface:       { type: "string", description: "UI surface this impression rendered into" },
                format:        { type: "string", description: "Creative format actually rendered" },
                intent_match_score: { type: "number", description: "Benna intent-match score returned by get_sponsored_content" },
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

// ── get_sponsored_content ───────────────────────────────────────────────
async function handleGetSponsoredContent(body, args, res) {
  const sessionId = args.session_id || "anon_" + Date.now();
  const auctionId = mintAuctionId();
  const t0 = Date.now();

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

  // Load campaigns
  let campaigns;
  if (sb) {
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
  if (args.developer_api_key && sb) {
    const { data: dev } = await sb.from("developers")
      .select("id, format_native, format_image, format_corner, format_video, format_fullscreen")
      .eq("api_key", args.developer_api_key).eq("status", "active").single();
    if (dev) {
      developerId = dev.id;
      developerFormats = {
        native:     dev.format_native !== false,
        image:      dev.format_image !== false,
        corner:     dev.format_corner !== false,
        video:      dev.format_video !== false,
        fullscreen: dev.format_fullscreen !== false,
      };
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

  // Look up cached per-token embeddings via a single indexed Postgres
  // query, average the hit vectors, and use that as the request-side
  // context vector. NO OpenAI calls in the hot path — any tokens that
  // miss the cache are logged async into intent_embedding_misses and
  // picked up by /api/embed-cron on the next tick. Returns null when
  // every token misses → Benna falls back to Jaccard.
  const requestEmbedding = await lookupCachedEmbedding([
    ...reqIntentTokens,
    ...(mcpCtx.active_tools || []).map((t) => t.replace(/-mcp$/, "")),
    ...(mcpCtx.host_app ? [mcpCtx.host_app] : []),
    ...(effectiveSurface ? [effectiveSurface] : []),
  ]);

  // Publisher-side brand-safety: refuse advertiser categories the publisher excluded.
  const excludedCats = (placement && placement.excluded_categories) || [];
  const excludedAdv  = (placement && placement.excluded_advertisers) || [];
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
  const afterPlacementFormat = afterFormatToggle.filter((c) => !placement || (c.format || "native") === placement.format);
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

  const candidatesScored = afterMcp.map((c) => {
      // p_click / p_convert / signal_contributions for the dashboard
      // "Why did this win" panel. scoreBid() reads the campaign's actual
      // target_* columns to compute per-signal contributions; scorePrice()
      // (below) handles the §9 auction pricing.
      const prediction = benna.scoreBid(bennaCtx, {
        target_cpa: c.target_cpa || c.bid_amount || 4.5,
        goal: c.optimization_goal || "target_cpa",
        format: c.format,
        target_intent_tokens: c.target_intent_tokens || [],
        target_active_tools: c.target_active_tools || [],
        target_host_apps:    c.target_host_apps    || [],
        target_surfaces:     c.target_surfaces     || [],
        target_keywords:     c.target_keywords     || [],
      });
      const priced = benna.scorePrice({
        placement: scorePlacement,
        context: {
          intent_tokens: reqIntentTokens,
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
    // Self-promoted campaigns win first; among the rest, highest CPM wins.
    .sort((a, b) => {
      if (a.selfPromote !== b.selfPromote) return a.selfPromote ? -1 : 1;
      return b.effective_price_cpm - a.effective_price_cpm;
    });

  // Materialize eligibility breakdown + candidates snapshot for the log.
  const winnerObj = scored[0] || null;
  logCtx.eligibility = {
    pool_size:              campaigns.length,
    after_eligible:         afterEligible.length,
    after_format_toggle:    afterFormatToggle.length,
    after_placement_format: afterPlacementFormat.length,
    after_blocklist_cat:    afterBlocklistCat.length,
    after_blocklist_adv:    afterBlocklistAdv.length,
    after_door:             afterDoor.length,
    after_mcp:              afterMcp.length,
    after_floor:            scored.length,
    drop_reasons: {
      eligible:         campaigns.length            - afterEligible.length,
      format_toggle:    afterEligible.length        - afterFormatToggle.length,
      placement_format: afterFormatToggle.length    - afterPlacementFormat.length,
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
      tracking: {
        impression:     `${track}&event=impression`,
        click:          `${track}&event=click`,
        close:          `${track}&event=close`,
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
        intent_tokens: reqIntentTokens,
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
module.exports._DEMO_EVENTS = DEMO_EVENTS;
module.exports._reset = function () {
  DEMO_EVENTS.length = 0;
  sessionCache.clear();
};
