// Smoke test — exercises the SDK surface without hitting the network.
// Run: node test/smoke.js

const assert = require("assert");
const bb = require("../src/index.js");
const { withBoostBoss, BB_TOOL_SCHEMA } = require("../src/mcp.js");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log("@boostboss/sdk smoke test");

  await test("exports named + default API", () => {
    assert.strictEqual(typeof bb.BoostBoss, "function");
    assert.strictEqual(typeof bb.getSponsoredContent, "function");
    assert.strictEqual(typeof bb.trackEvent, "function");
    assert.strictEqual(typeof bb.configure, "function");
    assert.strictEqual(bb.SDK_VERSION, "1.0.0");
  });

  await test("client instantiates and has sensible defaults", () => {
    const c = new bb.BoostBoss({ apiKey: "k_test" });
    assert.strictEqual(c.apiKey, "k_test");
    assert.strictEqual(c.defaultRegion, "global");
    assert.ok(c._sessionId.startsWith("sess_"));
  });

  await test("configure replaces default client", () => {
    const c = bb.configure({ apiKey: "k_new", region: "eu" });
    assert.strictEqual(c.defaultRegion, "eu");
  });

  await test("invalid event is rejected", async () => {
    const c = new bb.BoostBoss({ apiKey: "k" });
    await assert.rejects(() => c.trackEvent("nonsense", "camp_1"));
  });

  await test("onEvent fires on error path (no network)", async () => {
    const events = [];
    const c = new bb.BoostBoss({
      apiKey: "k",
      endpoint: "http://127.0.0.1:1/will-fail",
      timeoutMs: 50,
      onEvent: (n, p) => events.push([n, p]),
    });
    const res = await c.getSponsoredContent({ context: "test" });
    assert.strictEqual(res.sponsored, null);
    assert.ok(events.some(([n]) => n === "error"));
    assert.ok(events.some(([n]) => n === "ad_response"));
  });

  await test("withBoostBoss exposes tool in tools/list", async () => {
    const upstream = {
      async handle(req) {
        if (req.method === "tools/list") return { jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "search", description: "", inputSchema: { type: "object" } }] } };
      },
    };
    const wrapped = withBoostBoss(upstream, { apiKey: "k" });
    const r = await wrapped.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = r.result.tools.map((t) => t.name);
    assert.ok(names.includes("search"));
    assert.ok(names.includes("get_sponsored_content"));
  });

  await test("BB_TOOL_SCHEMA matches MCP shape", () => {
    assert.strictEqual(BB_TOOL_SCHEMA.name, "get_sponsored_content");
    assert.ok(BB_TOOL_SCHEMA.inputSchema.required.includes("context_summary"));
  });

  await test("gate suppresses ads when it returns false", async () => {
    const wrapped = withBoostBoss({ async handle() { return {}; } }, { apiKey: "k", gate: () => false });
    const r = await wrapped.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_sponsored_content", arguments: { context_summary: "x" } } });
    const payload = JSON.parse(r.result.content[0].text);
    assert.strictEqual(payload.sponsored, null);
    assert.strictEqual(payload.reason, "gated");
  });

  console.log(`\n${passed} checks passed.`);
})();
