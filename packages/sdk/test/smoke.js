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
  console.log("@boostbossai/lumi-sdk smoke test");

  await test("exports named + default API", () => {
    assert.strictEqual(typeof bb.BoostBoss, "function");
    assert.strictEqual(typeof bb.getSponsoredContent, "function");
    assert.strictEqual(typeof bb.trackEvent, "function");
    assert.strictEqual(typeof bb.configure, "function");
    assert.strictEqual(bb.SDK_VERSION, "1.1.0");
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

  // ─── BBX MCP-native fields (protocol §4.1) ───
  await test("getSponsoredContent forwards BBX targeting fields onto the wire", async () => {
    let captured = null;
    const c = new bb.BoostBoss({
      apiKey: "k",
      endpoint: "http://127.0.0.1:1/will-fail",
      timeoutMs: 30,
      placementId: "plc_default",
      surface: "chat",
      hostApp: "cursor",
    });
    // Stub _fetch to capture the payload instead of hitting the network
    c._fetch = async (_url, body) => { captured = body; return { result: { content: [{ text: '{"sponsored":null}' }] } }; };
    await c.getSponsoredContent({
      context: "billing integration",
      intentTokens: ["billing", "stripe"],
      activeTools: ["stripe-mcp"],
    });
    const args = captured.params.arguments;
    assert.strictEqual(args.placement_id, "plc_default");        // from constructor default
    assert.strictEqual(args.surface, "chat");                    // from constructor default
    assert.strictEqual(args.host_app, "cursor");                 // from constructor default
    assert.deepStrictEqual(args.intent_tokens, ["billing", "stripe"]);
    assert.deepStrictEqual(args.active_tools, ["stripe-mcp"]);
  });

  await test("per-call params override constructor defaults", async () => {
    let captured = null;
    const c = new bb.BoostBoss({ apiKey: "k", surface: "chat", hostApp: "cursor" });
    c._fetch = async (_u, b) => { captured = b; return { result: { content: [{ text: '{"sponsored":null}' }] } }; };
    await c.getSponsoredContent({
      context: "x",
      surface: "tool_response",
      hostApp: "claude_desktop",
      placementId: "plc_other",
    });
    const a = captured.params.arguments;
    assert.strictEqual(a.surface, "tool_response");
    assert.strictEqual(a.host_app, "claude_desktop");
    assert.strictEqual(a.placement_id, "plc_other");
  });

  await test("trackEvent auto-attaches auction_id from last ad_response", async () => {
    const c = new bb.BoostBoss({ apiKey: "k" });
    // Simulate a successful auction
    c._fetch = async () => ({
      result: { content: [{ text: JSON.stringify({
        sponsored: { campaign_id: "cmp_42", type: "native", headline: "x", subtext: "y", media_url: "", cta_label: "Go", cta_url: "https://x", skippable_after_sec: 3, tracking: { impression: "", click: "", close: "", video_complete: "" } },
        auction:   { auction_id: "ach_123", placement_id: "plc_chat", surface: "chat", format: "native", intent_match_score: 1.2, candidates_considered: 3, winning_price_cpm: 4.2, floor_cpm: 1, price_breakdown: {} },
      }) }] }
    });
    const ad = await c.getSponsoredContent({ context: "x" });
    assert.strictEqual(ad.sponsored.campaign_id, "cmp_42");

    // Now trackEvent should auto-include auction_id
    let trackPayload = null;
    c._fetch = async (_u, b) => { trackPayload = b; return { result: { content: [{ text: '{"tracked":true}' }] } }; };
    await c.trackEvent("impression", "cmp_42");
    const a = trackPayload.params.arguments;
    assert.strictEqual(a.auction_id, "ach_123");
    assert.strictEqual(a.placement_id, "plc_chat");
    assert.strictEqual(a.surface, "chat");
    assert.strictEqual(a.format, "native");
    assert.strictEqual(a.intent_match_score, 1.2);
  });

  await test("trackEvent opts override cached auction context", async () => {
    const c = new bb.BoostBoss({ apiKey: "k" });
    c._lastAuctionByCampaign.set("cmp_99", { auction_id: "ach_old", placement_id: "plc_old", surface: "chat", format: "native", intent_match_score: 0.8 });
    let payload = null;
    c._fetch = async (_u, b) => { payload = b; return { result: { content: [{ text: '{"tracked":true}' }] } }; };
    await c.trackEvent("click", "cmp_99", { auctionId: "ach_explicit", surface: "sidebar" });
    const a = payload.params.arguments;
    assert.strictEqual(a.auction_id, "ach_explicit");          // overridden
    assert.strictEqual(a.surface, "sidebar");                  // overridden
    assert.strictEqual(a.placement_id, "plc_old");             // fell through from cache
    assert.strictEqual(a.format, "native");                    // fell through from cache
  });

  console.log(`\n${passed} checks passed.`);
})();
