/**
 * Boost Boss — Public REST ad-request endpoint (Door 4).
 *
 * Wraps the internal MCP JSON-RPC auction with a clean, flat REST shape
 * so server-side bot integrations (Discord / Telegram / Slack) and any
 * other publisher backend can fetch ads without speaking JSON-RPC.
 *
 * Public URL:   POST https://boostboss.ai/v1/ad-request
 * Vercel route: api/ad-request.js (rewrite in vercel.json)
 *
 * Auth: Bearer token in Authorization header. The bearer is the
 *       publisher's API key — same value the MCP SDK uses internally
 *       as developer_api_key. Sandbox credentials (`sk_test_*` or
 *       `pub_test_*`) short-circuit through api/_lib/sandbox.js.
 *
 * Request body:
 *   {
 *     "format":        "embed" | "card" | "text" | "native" | "banner",
 *     "context":       string (required),
 *     "platform":      "discord" | "telegram" | "slack" | string (optional, hint),
 *     "user_region":   "US" | "EU" | ... (optional),
 *     "user_language": "en" | "es" | ... (optional),
 *     "session_id":    string (optional, used for frequency capping)
 *   }
 *
 * Response (200 with ad):
 *   {
 *     "ad": {
 *       "ad_id":            "cmp_abc",
 *       "auction_id":       "auc_xyz",
 *       "type":             "image" | "native" | "banner" | ...,
 *       "headline":         "...",
 *       "body":             "...",
 *       "image_url":        "https://..." | null,
 *       "cta_label":        "...",
 *       "click_url":        "https://boostboss.ai/api/track?...&event=click",
 *       "impression_url":   "https://boostboss.ai/api/track?...&event=impression",
 *       "disclosure_label": "Sponsored"
 *     }
 *   }
 *
 * Response (200 no fill):
 *   { "ad": null, "reason": "no_campaigns" | "rate_limited" | ... }
 *
 * Errors are HTTP status codes (401 missing/bad bearer, 400 bad body,
 * 405 wrong method, 5xx upstream). Body always JSON.
 */

const mcpHandler = require("./mcp.js");

module.exports = async function handler(req, res) {
  // CORS — public REST API, allow any origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Lumi-Source");
  res.setHeader("X-Boost-Boss-Endpoint", "v1/ad-request");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed", message: "Use POST." });
  }

  // ── Auth ──
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const apiKey = auth.replace(/^Bearer\s+/i, "").trim();
  if (!apiKey) {
    return res.status(401).json({
      error: "missing_authorization",
      message: "Authorization: Bearer <api_key> header required.",
    });
  }

  // ── Body validation ──
  const body = req.body || {};
  const context = String(body.context || "").trim();
  if (!context) {
    return res.status(400).json({
      error: "missing_context",
      message: "Body must include a non-empty `context` string.",
    });
  }
  const formatPref = String(body.format || "native").trim().toLowerCase();
  const sessionId  = String(body.session_id || "rest_" + Math.random().toString(36).slice(2, 10) + "_" + Date.now());

  // ── Build the synthetic MCP JSON-RPC request and forward to mcp.js ──
  // Same forwarding pattern mcp.js uses to call track.js for impression
  // events. Mock req/res capture the JSON-RPC response, which we then
  // unwrap into the flat REST shape.
  const mockReq = {
    method: "POST",
    headers: { "x-lumi-source": "rest-api", "content-type": "application/json" },
    query: {},
    body: {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "get_sponsored_content",
        arguments: {
          context_summary:   context,
          format_preference: formatPref,
          developer_api_key: apiKey,
          publisher_id:      apiKey,
          session_id:        sessionId,
          user_region:       body.user_region   ? String(body.user_region)   : undefined,
          user_language:     body.user_language ? String(body.user_language) : undefined,
          host_app:          body.platform      ? String(body.platform)      : "rest_api",
          surface:           body.surface       ? String(body.surface)       : null,
        },
      },
    },
  };

  let captured = { status: 200, body: null, headers: {} };
  const mockRes = {
    setHeader(k, v) { captured.headers[k.toLowerCase()] = v; },
    status(n) { captured.status = n; return this; },
    json(o) { captured.body = o; return this; },
    send(d) { captured.body = d; return this; },
    end() { return this; },
  };

  try {
    await mcpHandler(mockReq, mockRes);
  } catch (e) {
    console.error("[ad-request] upstream MCP error:", e && e.message);
    return res.status(502).json({
      error: "upstream_error",
      message: "Internal MCP handler failed.",
    });
  }

  // ── Unwrap the JSON-RPC envelope ──
  const env = captured.body;
  if (!env || typeof env !== "object") {
    return res.status(502).json({ error: "bad_upstream", message: "MCP returned no body." });
  }
  if (env.error) {
    // JSON-RPC error envelope. Map back to HTTP-shaped REST error.
    return res.status(captured.status >= 400 ? captured.status : 500).json({
      error: "upstream_error",
      message: env.error.message || "Auction failed.",
    });
  }

  const text = env.result && env.result.content && env.result.content[0] && env.result.content[0].text;
  if (!text) {
    return res.status(502).json({ error: "bad_upstream", message: "MCP result missing content." });
  }
  let payload;
  try { payload = JSON.parse(text); }
  catch (_e) {
    return res.status(502).json({ error: "bad_upstream", message: "MCP result not JSON." });
  }

  // ── No fill ──
  if (!payload.sponsored) {
    return res.status(200).json({
      ad: null,
      reason: payload.reason || "no_fill",
      auction_id: payload.auction_id || null,
    });
  }

  // ── Translate to flat REST shape ──
  const s = payload.sponsored;
  const a = payload.auction || {};
  return res.status(200).json({
    ad: {
      ad_id:            s.campaign_id,
      auction_id:       a.auction_id || null,
      type:             s.type || "native",
      headline:         s.headline || "",
      body:             s.subtext  || "",
      image_url:        s.media_url || null,
      cta_label:        s.cta_label || "Learn more",
      click_url:        (s.tracking && s.tracking.click)      || s.cta_url,
      impression_url:   (s.tracking && s.tracking.impression) || null,
      disclosure_label: s.disclosure_label || "Sponsored",
      sandbox:          a.sandbox === true,
    },
  });
};
