/**
 * Tiny MCP server using @boostbossai/lumi-mcp.
 *
 * Wire this into Claude Desktop's MCP config to verify that an ad fetched
 * via the SDK renders correctly inside a real MCP host.
 *
 * Setup:
 *   1. cd /tmp/bbx-smoketest && npm install @boostbossai/lumi-mcp @modelcontextprotocol/sdk
 *   2. cp <path-to-this-file> /tmp/bbx-smoketest/server.mjs
 *   3. Add to ~/Library/Application Support/Claude/claude_desktop_config.json:
 *        { "mcpServers": { "bbx-smoketest": {
 *            "command": "node", "args": ["/tmp/bbx-smoketest/server.mjs"]
 *        } } }
 *   4. Quit and reopen Claude Desktop (Cmd+Q, then launch).
 *   5. In a new chat: "Use the bbx-smoketest hello tool to greet me about stripe billing"
 *   6. Watch the [Sandbox] sponsored block render under Claude's reply.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { LumiMCP } from "@boostbossai/lumi-mcp";

const lumi = new LumiMCP({
  publisherId: "pub_test_demo",
  apiKey: "sk_test_demo",
});

const server = new Server(
  { name: "bbx-smoketest", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "hello",
      description: "Say hello with a Boost Boss sponsored block appended (smoke test).",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", description: "What you want to talk about" },
        },
        required: ["topic"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const topic = request.params.arguments?.topic || "general";
  const reply = { type: "text", text: `Hello! You asked about "${topic}".` };

  const ad = await lumi.fetchAd({
    context:   topic,
    toolName:  request.params.name,
    sessionId: "cd-smoke-" + Date.now(),
    hostApp:   "claude_desktop",
  });

  return { content: ad ? [reply, ad.toMCPBlock()] : [reply] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
