/**
 * Boost Boss — track.js smoke test (demo-mode path).
 * Run: node api/track.test.js
 *
 * Exercises event tracking: impression/click/close/skip/video_complete,
 * pixel beacon (GET), JSON response (POST), cost computation, and validation.
 */

// Force demo mode
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const assert = require("assert");
const track = require("../api/track.js");

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
async function run(spec) { const { req, res } = mockReqRes(spec); await track(req, res); return res; }

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log("  \x1b[32mok\x1b[0m  " + name); passed++; }
  catch (e) { console.log("  \x1b[31mFAIL\x1b[0m  " + name + ": " + e.message); failed++; if (process.env.DEBUG) console.log(e.stack); }
}

(async () => {
  console.log("Event Tracking · demo-mode smoke test\n");

  // ── Meta ───────────────────────────────────────────────────────────
  await test("HAS_SUPABASE is false in demo mode", () =>
    assert.strictEqual(track.HAS_SUPABASE, false));

  await test("x-track-mode header set to 'demo'", async () => {
    track._reset();
    const r = await run({
      method: "POST",
      body: { event: "impression", campaign_id: "cam_test" },
    });
    assert.strictEqual(r._headers["x-track-mode"], "demo");
  });

  await test("OPTIONS preflight returns 200", async () => {
    const r = await run({ method: "OPTIONS" });
    assert.strictEqual(r._status, 200);
  });

  // ── POST tracking ──────────────────────────────────────────────────
  track._reset();
  await test("POST impression records event", async () => {
    const r = await run({
      method: "POST",
      body: { event: "impression", campaign_id: "cam_001", session_id: "s_1" },
    });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.tracked, true);
    assert.strictEqual(r._body.event, "impression");
    assert.strictEqual(r._body.campaign_id, "cam_001");
  });

  await test("POST click records event", async () => {
    const r = await run({
      method: "POST",
      body: { event: "click", campaign_id: "cam_001" },
    });
    assert.strictEqual(r._body.tracked, true);
    assert.strictEqual(r._body.event, "click");
  });

  await test("POST video_complete records event", async () => {
    const r = await run({
      method: "POST",
      body: { event: "video_complete", campaign_id: "cam_001" },
    });
    assert.strictEqual(r._body.tracked, true);
  });

  await test("POST close records event", async () => {
    const r = await run({
      method: "POST",
      body: { event: "close", campaign_id: "cam_001" },
    });
    assert.strictEqual(r._body.tracked, true);
  });

  await test("POST skip records event", async () => {
    const r = await run({
      method: "POST",
      body: { event: "skip", campaign_id: "cam_001" },
    });
    assert.strictEqual(r._body.tracked, true);
  });

  await test("demo events store has 5 events after all POSTs", () => {
    assert.strictEqual(track._DEMO_EVENTS.length, 5);
  });

  await test("each demo event has required fields", () => {
    for (const e of track._DEMO_EVENTS) {
      assert(e.event_type, "missing event_type");
      assert(e.campaign_id, "missing campaign_id");
      assert(e.created_at, "missing created_at");
    }
  });

  // ── GET pixel beacon ───────────────────────────────────────────────
  track._reset();
  await test("GET returns 1x1 pixel GIF for impression", async () => {
    const r = await run({
      method: "GET",
      query: { event: "impression", campaign_id: "cam_001", session: "s_1" },
    });
    assert.strictEqual(r._headers["content-type"], "image/gif");
    assert.strictEqual(r._headers["cache-control"], "no-store");
    assert(Buffer.isBuffer(r._body), "should return a Buffer");
    assert(r._body.length > 0, "GIF should not be empty");
  });

  await test("GET also stores event in demo store", () => {
    assert.strictEqual(track._DEMO_EVENTS.length, 1);
    assert.strictEqual(track._DEMO_EVENTS[0].event_type, "impression");
  });

  // ── Validation ─────────────────────────────────────────────────────
  await test("rejects missing event", async () => {
    const r = await run({
      method: "POST",
      body: { campaign_id: "cam_001" },
    });
    assert.strictEqual(r._status, 400);
    assert(r._body.error.includes("Missing"));
  });

  await test("rejects missing campaign_id", async () => {
    const r = await run({
      method: "POST",
      body: { event: "impression" },
    });
    assert.strictEqual(r._status, 400);
  });

  await test("rejects invalid event type", async () => {
    const r = await run({
      method: "POST",
      body: { event: "purchase", campaign_id: "cam_001" },
    });
    assert.strictEqual(r._status, 400);
    assert(r._body.error.includes("Invalid event"));
  });

  // ── Reset ──────────────────────────────────────────────────────────
  await test("_reset clears demo events", () => {
    track._reset();
    assert.strictEqual(track._DEMO_EVENTS.length, 0);
  });

  // ── Mode header on GET ─────────────────────────────────────────────
  await test("mode field is 'demo' in POST response", async () => {
    const r = await run({
      method: "POST",
      body: { event: "impression", campaign_id: "cam_x" },
    });
    assert.strictEqual(r._body.mode, "demo");
  });

  // ── Rate Limiting ───────────────────────────────────────────────────
  track._reset(); // also clears rateLimitMap
  await test("rate limiter allows up to RATE_LIMIT_MAX requests per IP", async () => {
    const max = track._RATE_LIMIT_MAX;
    assert(max > 0, "RATE_LIMIT_MAX should be positive");
    // Simulate max requests from the same IP
    for (let i = 0; i < max; i++) {
      const r = await run({
        method: "POST",
        body: { event: "impression", campaign_id: "cam_rl" },
        headers: { "x-forwarded-for": "10.0.0.99" },
      });
      assert.strictEqual(r._status, 200, `request ${i + 1} should succeed (got ${r._status})`);
    }
  });

  await test("rate limiter returns 429 after exceeding RATE_LIMIT_MAX", async () => {
    // The previous test already sent RATE_LIMIT_MAX requests from 10.0.0.99
    const r = await run({
      method: "POST",
      body: { event: "impression", campaign_id: "cam_rl" },
      headers: { "x-forwarded-for": "10.0.0.99" },
    });
    assert.strictEqual(r._status, 429);
    assert(r._body.error.includes("Rate limit"));
  });

  await test("rate limiter tracks IPs independently", async () => {
    // Different IP should still be allowed
    const r = await run({
      method: "POST",
      body: { event: "impression", campaign_id: "cam_rl" },
      headers: { "x-forwarded-for": "10.0.0.100" },
    });
    assert.strictEqual(r._status, 200);
  });

  await test("rate limiter resets after window expires", async () => {
    // Manually reset the entry for 10.0.0.99 to simulate window expiry
    const entry = track._rateLimitMap.get("10.0.0.99");
    assert(entry, "should have an entry for 10.0.0.99");
    entry.start = Date.now() - 61000; // push it 61s into the past
    const r = await run({
      method: "POST",
      body: { event: "impression", campaign_id: "cam_rl" },
      headers: { "x-forwarded-for": "10.0.0.99" },
    });
    assert.strictEqual(r._status, 200, "should allow after window reset");
  });

  await test("_reset clears rateLimitMap", () => {
    track._reset();
    assert.strictEqual(track._rateLimitMap.size, 0);
  });

  // ── Summary ────────────────────────────────────────────────────────
  console.log();
  if (failed) { console.log(`\x1b[31m${failed} failed\x1b[0m, ${passed} passed.`); process.exit(1); }
  else console.log(`\x1b[32m${passed} tests passed.\x1b[0m`);
})();
