/**
 * Boost Boss — DEMAND-SIDE MCP server (advertiser harness)
 *
 * The MCP-native control surface for advertisers. Where api/mcp.js is the
 * SUPPLY side (serves ads to publishers via get_sponsored_content), THIS is
 * the DEMAND side: an MCP server a Claude / Cursor / agent harness connects to
 * and drives an advertiser account with — list/create/pause/resume/update
 * campaigns, read performance, manage products + creatives, read the account
 * balance.
 *
 * Transport: JSON-RPC 2.0 over HTTP POST (same shape as api/mcp.js).
 *   initialize                → handshake
 *   tools/list                → the tool catalog
 *   tools/call {name, args}   → run a tool
 *
 * Auth: the advertiser's bb_live_ API key as a Bearer token (Authorization
 * header) OR as arguments.api_key on the initialize/tool call. The key is
 * resolved ONCE to an advertiser_id; every tool then reuses the existing REST
 * handlers (campaigns/stats/products/billing/creative-assets) via an internal
 * mock req/res, so all logic + cross-tenant scoping is shared — no duplication.
 */

const { createClient } = require("@supabase/supabase-js");
const {
  resolveApiKeyToAdvertiser, looksLikeApiKey,
} = require("./_lib/advertiser_auth.js");

const campaigns      = require("./campaigns.js");
const stats          = require("./stats.js");
const billing        = require("./billing.js");
const creativeAssets = require("./creative-assets.js");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "";
const HAS_SUPABASE = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

let _sb = null;
function sb() {
  if (_sb) return _sb;
  if (!HAS_SUPABASE) return null;
  _sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  return _sb;
}

// ── JSON-RPC helpers ───────────────────────────────────────────────────
function rpc(res, id, result) {
  return res.status(200).json({ jsonrpc: "2.0", id: id ?? null, result });
}
function rpcErr(res, id, code, message, httpStatus) {
  return res.status(httpStatus || 200).json({
    jsonrpc: "2.0", id: id ?? null, error: { code, message },
  });
}

// Run an existing REST handler in-process with a synthesized req/res that
// carries the advertiser's Bearer key, so the handler's own resolveAdvertiser
// re-derives the SAME advertiser and all scoping/validation is reused.
function invoke(handler, { method, query, body, bearer }) {
  return new Promise((resolve) => {
    const req = {
      method: method || "GET",
      query: query || {},
      body: body || {},
      headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
    };
    const res = {
      _status: 200,
      setHeader() {},
      status(n) { this._status = n; return this; },
      json(o) { resolve({ status: this._status, body: o }); return this; },
      send(d) { resolve({ status: this._status, body: d }); return this; },
      end() { resolve({ status: this._status, body: null }); return this; },
    };
    Promise.resolve(handler(req, res)).catch((e) =>
      resolve({ status: 500, body: { error: (e && e.message) || "handler error" } }));
  });
}

// ── Tool catalog ───────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "list_campaigns",
    description: "List all campaigns on the advertiser account (status, budget, spend, format).",
    inputSchema: { type: "object", properties: {
      status: { type: "string", description: "Optional filter: active | paused | in_review | rejected" },
    } },
  },
  {
    name: "get_campaign",
    description: "Get one campaign by id.",
    inputSchema: { type: "object", properties: { campaign_id: { type: "string" } }, required: ["campaign_id"] },
  },
  {
    name: "create_campaign",
    description: "Create a new campaign. cta_url is required (the click destination); everything else inherits from the account creative library and sensible defaults.",
    inputSchema: { type: "object", properties: {
      cta_url:      { type: "string", description: "Click destination URL (required)" },
      name:         { type: "string" },
      bid_amount:   { type: "number", description: "USD, $0.01–$1000 (default 5)" },
      daily_budget: { type: "number", description: "USD, $1–$1,000,000 (default 50)" },
      total_budget: { type: "number", description: "USD, $1–$10,000,000 (default 1000)" },
      format:       { type: "string", description: "text_card | native | image | video (default native)" },
    }, required: ["cta_url"] },
  },
  {
    name: "pause_campaign",
    description: "Pause an active campaign.",
    inputSchema: { type: "object", properties: { campaign_id: { type: "string" } }, required: ["campaign_id"] },
  },
  {
    name: "resume_campaign",
    description: "Resume a paused campaign.",
    inputSchema: { type: "object", properties: { campaign_id: { type: "string" } }, required: ["campaign_id"] },
  },
  {
    name: "update_campaign",
    description: "Update a campaign's editable fields (name, budgets, bid, cta_url, format).",
    inputSchema: { type: "object", properties: {
      campaign_id:  { type: "string" },
      name:         { type: "string" },
      bid_amount:   { type: "number" },
      daily_budget: { type: "number" },
      total_budget: { type: "number" },
      cta_url:      { type: "string" },
      format:       { type: "string" },
    }, required: ["campaign_id"] },
  },
  {
    name: "get_stats",
    description: "Read account performance: impressions, clicks, CTR, spend, and per-surface/intent breakdowns.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_creative_library",
    description: "Read the account creative library (brand kit, headlines, body, CTAs, images, videos, voucher).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_creative_assets",
    description: "Patch creative-library fields. Provide any subset, e.g. { headlines_short:['...'], video_landscape_url:'https://...' }.",
    inputSchema: { type: "object", properties: {
      fields: { type: "object", description: "Partial creative_assets fields to upsert" },
    }, required: ["fields"] },
  },
  {
    name: "get_account",
    description: "Read the account balance / ad credits available for spend.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ── Tool dispatch ──────────────────────────────────────────────────────
async function callTool(name, args, bearer, advertiserId) {
  args = args || {};
  switch (name) {
    case "list_campaigns": {
      const q = {}; if (args.status) q.status = args.status;
      return invoke(campaigns, { method: "GET", query: q, bearer });
    }
    case "get_campaign":
      return invoke(campaigns, { method: "GET", query: { action: "get", id: args.campaign_id }, bearer });
    case "create_campaign":
      return invoke(campaigns, { method: "POST", query: { action: "create" }, body: args, bearer });
    case "pause_campaign":
      return invoke(campaigns, { method: "POST", query: { action: "pause" }, body: { id: args.campaign_id }, bearer });
    case "resume_campaign":
      return invoke(campaigns, { method: "POST", query: { action: "resume" }, body: { id: args.campaign_id }, bearer });
    case "update_campaign": {
      const body = Object.assign({}, args, { id: args.campaign_id });
      delete body.campaign_id;
      return invoke(campaigns, { method: "PATCH", query: { action: "update" }, body, bearer });
    }
    case "get_stats":
      // In production the handler derives the advertiser from the Bearer key
      // and ignores id; the fallback only matters for demo mode (no Supabase).
      return invoke(stats, { method: "GET", query: { type: "advertiser", id: advertiserId || "adv_demo" }, bearer });
    case "get_creative_library":
      return invoke(creativeAssets, { method: "GET", query: {}, bearer });
    case "set_creative_assets":
      return invoke(creativeAssets, { method: "PATCH", query: {}, body: args.fields || {}, bearer });
    case "get_account":
      return invoke(billing, { method: "GET", query: { action: "balance", id: advertiserId || "adv_demo" }, bearer });
    default:
      return { status: 404, body: { error: "unknown tool: " + name } };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return rpcErr(res, null, -32600, "Use POST (JSON-RPC 2.0)", 405);

  const body = req.body || {};
  const id = body.id;
  const method = body.method;

  // Bearer key (header) or arguments.api_key on the call.
  const headerKey = ((req.headers && req.headers.authorization) || "").replace(/^Bearer\s+/i, "").trim();
  const argKey = (body.params && body.params.arguments && body.params.arguments.api_key) || "";
  const key = headerKey || argKey;

  // ── initialize — handshake (no auth required to advertise capabilities) ──
  if (method === "initialize") {
    return rpc(res, id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "boostboss-advertiser", version: "0.1.0" },
      instructions: "Boost Boss demand-side control. Authenticate with your bb_live_ API key as a Bearer token. Call tools/list for available actions.",
    });
  }

  // ── tools/list ──
  if (method === "tools/list") {
    return rpc(res, id, { tools: TOOLS });
  }

  // ── tools/call ──
  if (method === "tools/call") {
    if (!key) return rpcErr(res, id, -32001, "Authentication required: pass your bb_live_ key as a Bearer token.");
    if (!looksLikeApiKey(key)) return rpcErr(res, id, -32001, "Invalid API key format (expected bb_live_…).");

    const client = sb();
    let advertiserId = null;
    if (client) {
      advertiserId = await resolveApiKeyToAdvertiser(key, client);
      if (!advertiserId) return rpcErr(res, id, -32001, "API key not recognized or revoked.");
    }
    // (demo mode: no Supabase — downstream handlers run their own demo paths)

    const name = body.params && body.params.name;
    const args = (body.params && body.params.arguments) || {};
    if (!name) return rpcErr(res, id, -32602, "Missing params.name");

    let out;
    try {
      out = await callTool(name, args, key, advertiserId);
    } catch (e) {
      return rpcErr(res, id, -32603, (e && e.message) || "tool execution failed");
    }

    const ok = out.status >= 200 && out.status < 300;
    return rpc(res, id, {
      content: [{ type: "text", text: JSON.stringify(out.body) }],
      isError: !ok,
    });
  }

  return rpcErr(res, id, -32601, "Unknown method: " + method);
};

// Exported for tests.
module.exports.TOOLS = TOOLS;
module.exports.callTool = callTool;
