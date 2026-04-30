/**
 * Boost Boss — sandbox mode smoke test.
 * Run: node tests/sandbox.test.js
 *
 * Verifies the pub_test_* / sk_test_* short-circuit in /api/mcp:
 *   • returns a fixed creative from the rotation pool
 *   • tags auction.sandbox: true
 *   • prefixes auction_id with auc_sandbox_
 *   • flags tracking URLs with &sandbox=1
 *   • rotates across multiple sessions (deterministic per session)
 *   • does NOT trigger sandbox for live credentials
 */

// Force demo mode (no Supabase) so we exercise the same code path the
// existing mcp tests use.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const assert = require("assert");
const mcp = require("../api/mcp.js");
const { isSandboxCredential, SANDBOX_CREATIVES } = require("../api/_lib/sandbox.js");

function mockReqRes({ method = "POST", body = null, query = {}, headers = {} } = {}) {
  const res = {
    _status: 200, _headers: {}, _body: null,
    setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
    status(n) { this._status = n; return this; },
    json(o) { this._body = o; this._headers["content-type"] = "application/json"; return this; },
    send(d) { this._body = d; return this; },
    end() { return this; },
  };
  return { req: { method, body, query, headers }, res };
}
async function call(args, sessionId = "test-session") {
  const { req, res } = mockReqRes({
    body: {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "get_sponsored_content",
        arguments: { context_summary: "test context", session_id: sessionId, ...args },
      },
    },
  });
  await mcp(req, res);
  if (!res._body || !res._body.result) throw new Error("no result: " + JSON.stringify(res._body));
  return JSON.parse(res._body.result.content[0].text);
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log("  \x1b[32mok\x1b[0m  " + name); passed++; }
  catch (e) { console.log("  \x1b[31mFAIL\x1b[0m  " + name + ": " + e.message); failed++; if (process.env.DEBUG) console.log(e.stack); }
}

(async () => {
  console.log("Sandbox mode · /api/mcp short-circuit\n");

  await test("isSandboxCredential detects pub_test_ prefix on publisher_id", () => {
    assert.strictEqual(isSandboxCredential({ publisher_id: "pub_test_demo" }), true);
  });
  await test("isSandboxCredential detects sk_test_ prefix on developer_api_key", () => {
    assert.strictEqual(isSandboxCredential({ developer_api_key: "sk_test_anything" }), true);
  });
  await test("isSandboxCredential tolerates pub_test_ as developer_api_key (docs example)", () => {
    assert.strictEqual(isSandboxCredential({ developer_api_key: "pub_test_demo" }), true);
  });
  await test("isSandboxCredential rejects production credentials", () => {
    assert.strictEqual(isSandboxCredential({ developer_api_key: "bb_dev_real_xyz" }), false);
    assert.strictEqual(isSandboxCredential({ publisher_id: "pub_real_xyz" }), false);
    assert.strictEqual(isSandboxCredential({}), false);
  });

  await test("sandbox returns a fixed creative from the rotation pool", async () => {
    mcp._reset();
    const r = await call({ developer_api_key: "sk_test_demo" });
    assert.ok(r.sponsored, "sponsored object missing");
    const ids = SANDBOX_CREATIVES.map((c) => c.campaign_id);
    assert.ok(ids.includes(r.sponsored.campaign_id), "creative not from pool: " + r.sponsored.campaign_id);
  });

  await test("sandbox auction_id prefixed with auc_sandbox_", async () => {
    mcp._reset();
    const r = await call({ developer_api_key: "sk_test_demo" }, "sandbox-prefix-test");
    assert.match(r.auction.auction_id, /^auc_sandbox_/);
  });

  await test("sandbox flag set on auction object", async () => {
    mcp._reset();
    const r = await call({ developer_api_key: "sk_test_demo" }, "sandbox-flag-test");
    assert.strictEqual(r.auction.sandbox, true);
  });

  await test("tracking URLs include &sandbox=1", async () => {
    mcp._reset();
    const r = await call({ developer_api_key: "sk_test_demo" }, "tracking-test");
    assert.match(r.sponsored.tracking.impression, /[?&]sandbox=1/);
    assert.match(r.sponsored.tracking.click,      /[?&]sandbox=1/);
  });

  await test("disclosure label includes 'TEST'", async () => {
    mcp._reset();
    const r = await call({ developer_api_key: "sk_test_demo" }, "disclosure-test");
    assert.match(r.sponsored.disclosure_label, /TEST/i);
  });

  await test("cta_url includes bbx_sandbox=1", async () => {
    mcp._reset();
    const r = await call({ developer_api_key: "sk_test_demo" }, "cta-test");
    assert.match(r.sponsored.cta_url, /bbx_sandbox=1/);
  });

  await test("rotation: 10 different sessions yield ≥3 distinct creatives", async () => {
    const ids = new Set();
    for (let i = 0; i < 10; i++) {
      mcp._reset();
      const r = await call({ developer_api_key: "sk_test_demo" }, "rotate-" + i);
      ids.add(r.sponsored.campaign_id);
    }
    assert.ok(ids.size >= 3, `only ${ids.size} unique creative(s) across 10 sessions`);
  });

  await test("same session always returns the same creative (deterministic)", async () => {
    mcp._reset();
    const r1 = await call({ developer_api_key: "sk_test_demo" }, "stable-session-1");
    mcp._reset();
    const r2 = await call({ developer_api_key: "sk_test_demo" }, "stable-session-1");
    assert.strictEqual(r1.sponsored.campaign_id, r2.sponsored.campaign_id);
  });

  await test("non-sandbox credential goes through real auction (regression)", async () => {
    mcp._reset();
    const r = await call({ developer_api_key: "bb_dev_real_xyz" }, "non-sandbox");
    // Either we got a real ad (auction.sandbox is false/undefined) or no fill,
    // but never an auc_sandbox_ id.
    assert.ok(!String(r.auction?.auction_id || "").startsWith("auc_sandbox_"),
      "non-sandbox call should not return auc_sandbox_ id");
    assert.notStrictEqual(r.auction?.sandbox, true);
  });

  await test("format_preference filters sandbox creative to matching type", async () => {
    mcp._reset();
    const r = await call({ developer_api_key: "sk_test_demo", format_preference: "image" }, "format-img");
    assert.strictEqual(r.sponsored.type, "image");
  });

  console.log(`\n${passed === passed + failed ? "\x1b[32m" : "\x1b[31m"}${passed} tests passed.${failed ? ` ${failed} FAILED.` : ""}\x1b[0m`);
  process.exit(failed ? 1 : 0);
})();
