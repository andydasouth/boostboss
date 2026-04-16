/**
 * Boost Boss — Lumi SDK MCP Server
 *
 * The JSON-RPC 2.0 endpoint that the @boostboss/sdk talks to. Implements
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

// ────────────────────────────────────────────────────────────────────────
//                                HANDLER
// ────────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("x-mcp-mode", HAS_SUPABASE ? "supabase" : "demo");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};

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
            description: "Get a contextually relevant sponsored recommendation matched to conversation context. Ads are ranked in real time by Benna AI using MCP signals (intent, tool, host, session).",
            inputSchema: {
              type: "object",
              properties: {
                context_summary: { type: "string", description: "What the user is currently working on or asking about" },
                user_region:     { type: "string", description: "Region: US, EU, APAC, LATAM, global" },
                user_language:   { type: "string", description: "Language: en, zh, es, ja, ko" },
                session_id:      { type: "string", description: "Unique session ID" },
                developer_api_key: { type: "string", description: "Developer Lumi SDK API key" },
                format_preference: { type: "string", enum: ["image", "video", "native", "any"] },
                host:            { type: "string", description: "Host application (e.g., cursor.com) — Benna AI uses this as a ranking signal" },
                session_len_min: { type: "number", description: "Minutes in-session — longer sessions signal stronger intent" },
              },
              required: ["context_summary"],
            },
          },
          {
            name: "track_event",
            description: "Track ad event: impression, click, close, video_complete, skip",
            inputSchema: {
              type: "object",
              properties: {
                event:         { type: "string", enum: ["impression", "click", "close", "video_complete", "skip"] },
                campaign_id:   { type: "string" },
                session_id:    { type: "string" },
                developer_api_key: { type: "string" },
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

  return res.status(400).json({ error: "Unknown MCP method" });
};

// ── get_sponsored_content ───────────────────────────────────────────────
async function handleGetSponsoredContent(body, args, res) {
  const sessionId = args.session_id || "anon_" + Date.now();

  // Rate limit
  const last = sessionCache.get(sessionId);
  if (last && Date.now() - last < RATE_LIMIT_MS) {
    return jsonRpc(res, body.id, { sponsored: null, reason: "rate_limited" });
  }

  // Load campaigns
  let campaigns;
  const sb = supa();
  if (sb) {
    const { data, error } = await sb.from("campaigns").select("*").eq("status", "active");
    if (error || !data || data.length === 0) {
      return jsonRpc(res, body.id, { sponsored: null, reason: "no_campaigns" });
    }
    campaigns = data;
  } else {
    campaigns = demoCampaigns();
    if (campaigns.length === 0) {
      return jsonRpc(res, body.id, { sponsored: null, reason: "no_campaigns" });
    }
  }

  // Resolve developer
  let developerId = null;
  if (args.developer_api_key && sb) {
    const { data: dev } = await sb.from("developers")
      .select("id").eq("api_key", args.developer_api_key).eq("status", "active").single();
    if (dev) developerId = dev.id;
  }

  // Benna-powered first-price auction
  const region = args.user_region || "global";
  const lang = args.user_language || "en";
  const bennaCtx = deriveBennaContext(args);

  const scored = campaigns
    .filter((c) => eligible(c, region, lang))
    .map((c) => {
      const kwBoost = keywordContextBoost(c, args.context_summary);
      const prediction = benna.scoreBid(bennaCtx, {
        target_cpa: c.target_cpa || c.bid_amount || 4.5,
        goal: c.optimization_goal || "target_cpa",
        format: c.format,
      });
      const effectiveBid = prediction.bid_usd * (1 + kwBoost * 0.15);
      return { c, prediction, kwBoost, effectiveBid };
    })
    .filter((x) => x.effectiveBid > 0)
    .sort((a, b) => b.effectiveBid - a.effectiveBid);

  if (scored.length === 0) {
    return jsonRpc(res, body.id, { sponsored: null, reason: "no_match" });
  }

  const winner = scored[0];
  const w = winner.c;
  const p = winner.prediction;
  sessionCache.set(sessionId, Date.now());

  const base = process.env.BOOSTBOSS_BASE_URL || "https://boostboss.ai";
  const track = `${base}/api/track?campaign_id=${w.id}&session=${sessionId}&dev=${developerId || ""}`;

  return jsonRpc(res, body.id, {
    sponsored: {
      campaign_id: w.id,
      type: w.format,
      headline: w.headline,
      subtext: w.subtext,
      media_url: w.media_url,
      poster_url: w.poster_url || null,
      cta_label: w.cta_label,
      cta_url: w.cta_url,
      skippable_after_sec: w.skippable_after_sec || 3,
      tracking: {
        impression:     `${track}&event=impression`,
        click:          `${track}&event=click`,
        close:          `${track}&event=close`,
        video_complete: `${track}&event=video_complete`,
      },
    },
    benna: {
      model_version: p.model_version,
      bid_usd: p.bid_usd,
      effective_bid_usd: +winner.effectiveBid.toFixed(4),
      p_click: p.p_click,
      p_convert: p.p_convert,
      signal_contributions: p.signal_contributions,
      latency_ms: p.latency_ms,
      candidates_considered: scored.length,
      context: bennaCtx,
    },
  });
}

// ── track_event ─────────────────────────────────────────────────────────
async function handleTrackEvent(body, args, res) {
  const sb = supa();
  if (sb) {
    const { error } = await sb.from("events").insert({
      event_type: args.event,
      campaign_id: args.campaign_id,
      session_id: args.session_id || null,
    });
    return jsonRpc(res, body.id, { tracked: !error });
  }
  DEMO_EVENTS.push({
    event_type: args.event,
    campaign_id: args.campaign_id,
    session_id: args.session_id || null,
    created_at: new Date().toISOString(),
  });
  return jsonRpc(res, body.id, { tracked: true });
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
