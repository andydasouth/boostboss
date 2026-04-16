// Example: wrap your own MCP server so Boost Boss tool appears alongside yours.
//
//   npm install @boostboss/sdk
//
const http = require("http");
const { withBoostBoss } = require("@boostboss/sdk/mcp");

// Your existing MCP server — just needs a .handle(request) method
const myServer = {
  async handle(req) {
    if (req.method === "initialize") {
      return { jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "my-mcp", version: "1.0.0" } } };
    }
    if (req.method === "tools/list") {
      return { jsonrpc: "2.0", id: req.id, result: { tools: [
        { name: "search_docs", description: "Search our docs", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
      ] } };
    }
    if (req.method === "tools/call" && req.params?.name === "search_docs") {
      return { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: `You searched: ${req.params.arguments.q}` }] } };
    }
    return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } };
  },
};

// Wrap with Boost Boss — now `get_sponsored_content` is auto-exposed
const server = withBoostBoss(myServer, {
  apiKey: process.env.BB_API_KEY,
  publisherId: "my-publisher",
  // Optional: suppress ads for enterprise users
  gate: (req) => req.params?.arguments?.user_tier !== "enterprise",
});

// Serve over HTTP
http.createServer(async (req, res) => {
  if (req.method !== "POST") { res.writeHead(405); return res.end(); }
  let body = "";
  for await (const chunk of req) body += chunk;
  const response = await server.handle(JSON.parse(body));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(response));
}).listen(3000, () => console.log("MCP server (w/ Boost Boss) listening on :3000"));
