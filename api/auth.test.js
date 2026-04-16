/**
 * Boost Boss — auth.js smoke test (demo-mode path).
 * Run: node api/auth.test.js
 *
 * The Supabase path requires live infra so we only test the demo path here.
 * That's the path that runs on every preview deploy and during investor demos.
 */

// Force demo mode regardless of env
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
process.env.JWT_SECRET = "test-secret-do-not-use";

const assert = require("assert");
const handler = require("./auth.js");

function mockReqRes({ method = "POST", body = {}, query = {}, headers = {} } = {}) {
  const res = {
    _status: 200, _headers: {}, _body: null,
    setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
    status(n) { this._status = n; return this; },
    json(obj) { this._body = obj; this._headers["content-type"] = "application/json"; return this; },
    end() { return this; },
  };
  return { req: { method, body, query, headers }, res };
}

async function run(spec) {
  const { req, res } = mockReqRes(spec);
  await handler(req, res);
  return res;
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log("  \x1b[32mok\x1b[0m  " + name); passed++; }
  catch (e) { console.log("  \x1b[31mFAIL\x1b[0m  " + name + ": " + e.message); failed++; if (process.env.DEBUG) console.log(e.stack); }
}

(async () => {
  console.log("BBX Auth · demo-mode smoke test\n");

  await test("rejects non-POST", async () => {
    const r = await run({ method: "GET" });
    assert.strictEqual(r._status, 405);
  });

  await test("OPTIONS is a 200 (CORS preflight)", async () => {
    const r = await run({ method: "OPTIONS" });
    assert.strictEqual(r._status, 200);
  });

  await test("x-auth-mode header set to 'demo'", async () => {
    const r = await run({ method: "POST", query: { action: "demo" }, body: { role: "advertiser" } });
    assert.strictEqual(r._headers["x-auth-mode"], "demo");
  });

  await test("rejects unknown action", async () => {
    const r = await run({ method: "POST", query: { action: "wat" } });
    assert.strictEqual(r._status, 400);
  });

  // ── DEMO QUICK-START ─────────────────────────────────────────────
  await test("demo action creates an advertiser by default", async () => {
    const r = await run({ method: "POST", query: { action: "demo" }, body: {} });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.user.role, "advertiser");
    assert.ok(r._body.session.access_token);
    assert.ok(r._body.profile.company_name);
    assert.ok(r._body.profile.api_key.startsWith("bb_adv_live_"));
  });

  await test("demo action with role=developer creates a developer", async () => {
    const r = await run({ method: "POST", query: { action: "demo" }, body: { role: "developer" } });
    assert.strictEqual(r._body.user.role, "developer");
    assert.ok(r._body.profile.app_name);
    assert.ok(r._body.profile.api_key.startsWith("bb_dev_live_"));
    assert.ok(r._body.profile.fill_rate >= 0 && r._body.profile.fill_rate <= 1);
  });

  // ── SIGNUP / LOGIN / ME ROUNDTRIP ────────────────────────────────
  let sessionToken;

  await test("signup creates a user and returns a session token", async () => {
    const r = await run({
      method: "POST", query: { action: "signup" },
      body: { email: "alice@cursor.com", password: "hunter2!", role: "advertiser", company_name: "Cursor Labs" },
    });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.user.email, "alice@cursor.com");
    assert.strictEqual(r._body.profile.company_name, "Cursor Labs");
    assert.ok(r._body.session.access_token);
    sessionToken = r._body.session.access_token;
  });

  await test("signup rejects short passwords", async () => {
    const r = await run({
      method: "POST", query: { action: "signup" },
      body: { email: "x@y.com", password: "1", role: "advertiser" },
    });
    assert.strictEqual(r._status, 400);
  });

  await test("signup rejects unknown role", async () => {
    const r = await run({
      method: "POST", query: { action: "signup" },
      body: { email: "x@y.com", password: "hunter2!", role: "ceo" },
    });
    assert.strictEqual(r._status, 400);
  });

  await test("signup rejects missing fields", async () => {
    const r = await run({ method: "POST", query: { action: "signup" }, body: { email: "x@y.com" } });
    assert.strictEqual(r._status, 400);
  });

  await test("me with valid token returns the user profile", async () => {
    const r = await run({
      method: "POST", query: { action: "me" },
      headers: { authorization: "Bearer " + sessionToken },
    });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.user.email, "alice@cursor.com");
    assert.strictEqual(r._body.profile.company_name, "Cursor Labs");
  });

  await test("me with no token returns 401", async () => {
    const r = await run({ method: "POST", query: { action: "me" } });
    assert.strictEqual(r._status, 401);
  });

  await test("me with tampered token returns 401", async () => {
    const tampered = sessionToken.slice(0, -4) + "AAAA";
    const r = await run({
      method: "POST", query: { action: "me" },
      headers: { authorization: "Bearer " + tampered },
    });
    assert.strictEqual(r._status, 401);
  });

  await test("login auto-provisions an unknown email (frictionless demo)", async () => {
    const r = await run({
      method: "POST", query: { action: "login" },
      body: { email: "stranger@example.com", password: "anything-works" },
    });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.user.email, "stranger@example.com");
    assert.ok(r._body.session.access_token);
  });

  await test("login returns the same user_id for the same email (deterministic)", async () => {
    const r1 = await run({ method: "POST", query: { action: "login" }, body: { email: "bob@example.com", password: "x" } });
    const r2 = await run({ method: "POST", query: { action: "login" }, body: { email: "bob@example.com", password: "y" } });
    assert.strictEqual(r1._body.user.id, r2._body.user.id);
  });

  await test("logout returns success", async () => {
    const r = await run({
      method: "POST", query: { action: "logout" },
      headers: { authorization: "Bearer " + sessionToken },
    });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.success, true);
  });

  // ── JWT INTERNALS ────────────────────────────────────────────────
  await test("signJwt + verifyJwt roundtrip", async () => {
    const tok = handler.signJwt({ sub: "u_abc", email: "x@y.com", role: "advertiser", iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + 60 });
    const claims = handler.verifyJwt(tok);
    assert.ok(claims, "claims must be returned");
    assert.strictEqual(claims.sub, "u_abc");
    assert.strictEqual(claims.email, "x@y.com");
  });

  await test("verifyJwt rejects expired tokens", async () => {
    const tok = handler.signJwt({ sub: "u_abc", iat: 1, exp: 100 });
    assert.strictEqual(handler.verifyJwt(tok), null);
  });

  await test("verifyJwt rejects malformed input", async () => {
    assert.strictEqual(handler.verifyJwt(""), null);
    assert.strictEqual(handler.verifyJwt("not.a.jwt"), null);
    assert.strictEqual(handler.verifyJwt(null), null);
  });

  await test("userIdFromEmail is deterministic + email-normalized", async () => {
    const a = handler.userIdFromEmail("Alice@Cursor.com  ");
    const b = handler.userIdFromEmail("alice@cursor.com");
    assert.strictEqual(a, b);
    assert.ok(a.startsWith("u_") && a.length === 18);
  });

  console.log();
  if (failed) { console.log(`\x1b[31m${failed} failed\x1b[0m, ${passed} passed.`); process.exit(1); }
  else console.log(`\x1b[32m${passed} checks passed.\x1b[0m`);
})();
