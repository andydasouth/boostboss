/**
 * withBoostBoss — MCP server middleware.
 *
 * Wraps any MCP server (JSON-RPC 2.0 handler) so that a new tool
 * `get_sponsored_content` is exposed to the host without the publisher
 * having to plumb it themselves.
 *
 * Usage:
 *   const { withBoostBoss } = require("@boostboss/sdk/mcp");
 *   const server = withBoostBoss(yourMcpServer, {
 *     apiKey: process.env.BB_API_KEY,
 *     publisherId: "your-publisher-id",
 *   });
 *   server.listen();
 */

const { BoostBoss } = require("./index.js");

const BB_TOOL_SCHEMA = {
  name: "get_sponsored_content",
  description: "Fetch a contextually relevant sponsored recommendation from Boost Boss. Ranked in real time by Benna.",
  inputSchema: {
    type: "object",
    properties: {
      context_summary: { type: "string", description: "What the user is currently working on or asking about" },
      host: { type: "string", description: "Host application (cursor.com, claude.ai, raycast.com, perplexity.ai)" },
      user_region: { type: "string" },
      user_language: { type: "string" },
      format_preference: { type: "string", enum: ["image", "video", "native", "any"] },
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
        format: args.format_preference || "any",
        region: args.user_region,
        language: args.user_language,
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
