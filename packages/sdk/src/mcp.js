/**
 * withBoostBoss — MCP server middleware.
 *
 * Wraps any MCP server (JSON-RPC 2.0 handler) so that a new tool
 * `get_sponsored_content` is exposed to the host without the publisher
 * having to plumb it themselves.
 *
 * Usage:
 *   const { withBoostBoss } = require("@boostbossai/lumi-sdk/mcp");
 *   const server = withBoostBoss(yourMcpServer, {
 *     apiKey: process.env.BB_API_KEY,
 *     publisherId: "your-publisher-id",
 *   });
 *   server.listen();
 */

const { BoostBoss } = require("./index.js");

const BB_TOOL_SCHEMA = {
  name: "get_sponsored_content",
  description: "Fetch a contextually relevant sponsored recommendation from Boost Boss. Ranked in real time by Benna using MCP signals (intent_tokens, active_tools, host_app, surface).",
  inputSchema: {
    type: "object",
    properties: {
      context_summary:   { type: "string", description: "What the user is currently working on or asking about" },
      host:              { type: "string", description: "Host URL or app name (cursor.com, claude.ai, raycast.com, perplexity.ai)" },
      host_app:          { type: "string", description: "Canonical host app: cursor, claude_desktop, vscode, jetbrains" },
      user_region:       { type: "string" },
      user_language:     { type: "string" },
      format_preference: { type: "string", enum: ["image", "video", "native", "any"] },
      placement_id:      { type: "string", description: "Publisher placement_id (recommended) — enables floor + freq cap + per-placement reporting" },
      surface:           { type: "string", enum: ["chat", "tool_response", "sidebar", "loading_screen", "status_line", "web"] },
      intent_tokens:     { type: "array", items: { type: "string" }, description: "Free-form intent strings advertisers bid against" },
      active_tools:      { type: "array", items: { type: "string" }, description: "Canonical names of MCP servers currently connected" },
    },
    required: ["context_summary"],
  },
};

/**
 * @param {object} server  Your existing MCP server; must expose { handle(request): Promise<response> }
 * @param {object} opts    { apiKey, publisherId, region, language, gate }
 */
function withBoostBoss(server, opts = {}) {
  const bb = new BoostBoss({
    apiKey: opts.apiKey,
    region: opts.region,
    language: opts.language,
    placementId: opts.placementId,
    surface:     opts.surface,
    hostApp:     opts.hostApp,
  });
  // Optional gate: function returning false to suppress ads on certain requests
  const gate = opts.gate || (() => true);

  const originalHandle = typeof server.handle === "function" ? server.handle.bind(server) : null;

  async function handle(request) {
    // Inject our tool into tools/list
    if (request?.method === "tools/list") {
      const upstream = originalHandle ? await originalHandle(request) : { jsonrpc: "2.0", id: request.id, result: { tools: [] } };
      const tools = (upstream?.result?.tools || []).slice();
      if (!tools.find((t) => t.name === BB_TOOL_SCHEMA.name)) tools.push(BB_TOOL_SCHEMA);
      return { ...upstream, result: { ...(upstream.result || {}), tools } };
    }

    // Intercept tools/call for our tool
    if (request?.method === "tools/call" && request?.params?.name === BB_TOOL_SCHEMA.name) {
      if (!gate(request)) {
        return { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify({ sponsored: null, reason: "gated" }) }] } };
      }
      const args = request.params.arguments || {};
      const ad = await bb.getSponsoredContent({
        context: args.context_summary,
        host: args.host,
        hostApp: args.host_app,
        format: args.format_preference || "any",
        region: args.user_region,
        language: args.user_language,
        placementId: args.placement_id,
        surface: args.surface,
        intentTokens: args.intent_tokens,
        activeTools: args.active_tools,
      });
      return { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(ad) }] } };
    }

    // Everything else — pass through
    if (originalHandle) return originalHandle(request);
    return { jsonrpc: "2.0", id: request?.id, error: { code: -32601, message: "Method not found" } };
  }

  return { ...server, handle, _bb: bb };
}

module.exports = { withBoostBoss, BB_TOOL_SCHEMA };
