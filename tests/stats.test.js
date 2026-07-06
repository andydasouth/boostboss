/**
 * Boost Boss — stats.js smoke test (demo-mode path).
 * Run: node tests/stats.test.js
 *
 * Focused on the Phase H Panel 1 endpoint (type=live_activity). The
 * Supabase-backed code paths in stats.js are exercised by the recon
 * suite + the validation runbook; this file's purpose is to lock in
 * the live_activity contract that the admin UI depends on.
 */

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const assert = require("assert");
const stats = require("../api/stats.js");

function mockReqRes({ method = "GET", body = null, query = {}, headers = {} } = {}) {
  const res = {
    _status: 200, _headers: {}, _body: null,
    setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
    status(n) { this._status = n; return this; },
    json(o) { this._body = o; this._headers["content-type"] = "application/json"; return this; },
    end() { return this; },
  };
  return { req: { method, body, query, headers }, res };
}
async function run(spec) { const { req, res } = mockReqRes(spec); await stats(req, res); return res; }

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log("  \x1b[32mok\x1b[0m  " + name); passed++; }
  catch (e) { console.log("  \x1b[31mFAIL\x1b[0m  " + name + ": " + e.message); failed++; }
}

(async () => {
  console.log("Boost Boss · stats.js · demo-mode smoke test\n");

  await test("HAS_SUPABASE is false in demo mode", () => {
    assert.strictEqual(stats.HAS_SUPABASE, false);
  });

  await test("OPTIONS preflight returns 200", async () => {
    const r = await run({ method: "OPTIONS" });
    assert.strictEqual(r._status, 200);
  });

  // ── live_activity ───────────────────────────────────────────────────
  await test("live_activity returns 200 with full shape in demo mode", async () => {
    const r = await run({ method: "GET", query: { type: "live_activity" } });
    assert.strictEqual(r._status, 200);
    const b = r._body;
    assert.strictEqual(b.mode, "production");
    assert(b.generated_at, "should include generated_at");
    assert(b.health, "should include health card");
    assert.strictEqual(typeof b.health.status, "string");
    assert(b.volume, "should include volume card");
    assert(b.money,  "should include money card");
    assert(Array.isArray(b.top_publishers), "top_publishers should be an array");
    assert(Array.isArray(b.top_campaigns),  "top_campaigns should be an array");
    assert(Array.isArray(b.by_door),        "by_door should be an array");
    assert.strictEqual(b.by_door.length, 4, "should have 4 doors");
    const doorIds = b.by_door.map((d) => d.door).sort();
    assert.deepStrictEqual(doorIds, ["js-snippet", "mcp", "npm-sdk", "rest-api"]);
    assert(Array.isArray(b.recent_alerts), "recent_alerts should be an array");
  });

  await test("live_activity respects mode=sandbox query param", async () => {
    const r = await run({ method: "GET", query: { type: "live_activity", mode: "sandbox" } });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.mode, "sandbox");
  });

  await test("live_activity defaults to production for unknown mode", async () => {
    const r = await run({ method: "GET", query: { type: "live_activity", mode: "bogus" } });
    assert.strictEqual(r._body.mode, "production");
  });

  await test("live_activity demo response has zeroed counters and known status enum", async () => {
    const r = await run({ method: "GET", query: { type: "live_activity" } });
    const b = r._body;
    assert(["healthy", "watch", "action_required"].includes(b.health.status));
    assert.strictEqual(b.volume.auctions_5m, 0);
    assert.strictEqual(b.volume.auctions_1h, 0);
    assert.strictEqual(b.volume.auctions_24h, 0);
    assert.strictEqual(b.money.advertiser_spend_24h, 0);
    assert.strictEqual(b.money.bb_revenue_24h, 0);
  });

  await test("live_activity by_door entries include active_publishers count", async () => {
    const r = await run({ method: "GET", query: { type: "live_activity" } });
    for (const d of r._body.by_door) {
      assert.strictEqual(typeof d.active_publishers, "number",
        `door ${d.door} should expose active_publishers as a number`);
      assert.strictEqual(d.active_publishers, 0, "demo mode → zero publishers");
    }
  });

  await test("live_activity exposes door_timeseries array", async () => {
    const r = await run({ method: "GET", query: { type: "live_activity" } });
    assert(Array.isArray(r._body.door_timeseries),
      "door_timeseries should be an array");
    assert.strictEqual(r._body.door_timeseries.length, 0,
      "demo mode → empty time-series");
  });

  await test("live_activity rejects non-GET methods (would be 405-ish — currently falls through)", async () => {
    // POST falls through to the 400-default branch; we just want to lock
    // that it doesn't trigger handleLiveActivity.
    const r = await run({ method: "POST", query: { type: "live_activity" } });
    assert.strictEqual(r._status, 400);
  });

  // ── money_flow (Phase H Panel 2) ────────────────────────────────────
  await test("money_flow returns 200 with full shape in demo mode", async () => {
    const r = await run({ method: "GET", query: { type: "money_flow" } });
    assert.strictEqual(r._status, 200);
    const b = r._body;
    assert.strictEqual(b.mode, "production");
    assert(b.windows, "should include windows");
    assert(b.windows["24h"], "should include 24h window");
    assert(b.windows["7d"],  "should include 7d window");
    assert(b.windows["30d"], "should include 30d window");
    assert.strictEqual(typeof b.windows["24h"].advertiser_spend, "number");
    assert.strictEqual(typeof b.windows["24h"].bb_revenue, "number");
    assert.strictEqual(typeof b.windows["24h"].publisher_accrued, "number");
    assert(Array.isArray(b.top_advertisers_by_spend_24h));
    assert(Array.isArray(b.top_publishers_by_balance));
    assert(b.balance_drift, "should include balance_drift");
  });

  await test("money_flow respects mode=sandbox", async () => {
    const r = await run({ method: "GET", query: { type: "money_flow", mode: "sandbox" } });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.mode, "sandbox");
  });

  await test("money_flow demo returns zeroed but well-shaped windows", async () => {
    const r = await run({ method: "GET", query: { type: "money_flow" } });
    const b = r._body;
    assert.strictEqual(b.windows["24h"].advertiser_spend, 0);
    assert.strictEqual(b.windows["7d"].advertiser_spend,  0);
    assert.strictEqual(b.windows["30d"].advertiser_spend, 0);
    assert.strictEqual(b.advertiser_deposits_24h, 0);
    assert.strictEqual(b.balance_drift.checked, 0);
    assert.strictEqual(b.balance_drift.drifted, 0);
  });

  await test("money_flow exposes per-door breakdown with full shape", async () => {
    const r = await run({ method: "GET", query: { type: "money_flow" } });
    const b = r._body;
    assert(Array.isArray(b.by_door), "by_door should be an array");
    assert.strictEqual(b.by_door.length, 4, "should have 4 doors");
    const doorIds = b.by_door.map((d) => d.door).sort();
    assert.deepStrictEqual(doorIds, ["js-snippet", "mcp", "npm-sdk", "rest-api"]);
    for (const d of b.by_door) {
      assert.strictEqual(typeof d.advertiser_spend, "number");
      assert.strictEqual(typeof d.bb_revenue, "number");
      assert.strictEqual(typeof d.publisher_accrued, "number");
      assert.strictEqual(typeof d.impressions, "number");
      assert.strictEqual(d.advertiser_spend, 0, "demo mode → zero spend");
    }
  });

  // ── auction_inspect (Phase H Panel 3) ───────────────────────────────
  await test("auction_inspect list returns 200 with empty list in demo mode", async () => {
    const r = await run({ method: "GET", query: { type: "auction_inspect" } });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.count, 0);
    assert(Array.isArray(r._body.logs));
  });

  await test("auction_inspect detail returns 404 for unknown id in demo mode", async () => {
    const r = await run({ method: "GET", query: { type: "auction_inspect", id: "no-such-id" } });
    assert.strictEqual(r._status, 404);
  });

  await test("auction_inspect rejects non-GET", async () => {
    const r = await run({ method: "POST", query: { type: "auction_inspect" } });
    assert.strictEqual(r._status, 400);
  });

  // ── auction_inspect detail timeline + publisher credit (Panel 3 patch) ─
  //
  // These tests run the detail handler directly with a stubbed Supabase
  // client so we can exercise the timeline+credit shape end-to-end in
  // demo mode (handleAuctionInspect normally requires HAS_SUPABASE for
  // detail mode — see the early-return at the top of the handler).
  function makeStubSb({ auctionRow, eventsRows, publisherRow, campaignRow, balanceRow }) {
    function builder(table) {
      let _data = null;
      let _maybeSingle = false;
      switch (table) {
        case "auction_logs":  _data = auctionRow;  break;
        case "events":        _data = eventsRows;  break;
        case "developers":    _data = publisherRow;_maybeSingle = true; break;
        case "campaigns":     _data = campaignRow; _maybeSingle = true; break;
        case "publisher_balance": _data = balanceRow; _maybeSingle = true; break;
      }
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        order() { return chain; },
        in() { return chain; },
        async maybeSingle() {
          // Match the single-row return shape used by auction_logs lookup too.
          return { data: _data, error: null };
        },
        // For events we await the builder directly (it iterates rows).
        then(resolve) { resolve({ data: _data, error: null }); },
      };
      return chain;
    }
    return { from: builder };
  }

  await test("auction_inspect detail surfaces timeline keys with ✓/✗ semantics", async () => {
    // Manually invoke the exported handler with a stub supabase. We can't
    // round-trip through the http handler because handleAuctionInspect
    // detail mode early-returns 404 in demo mode. So we shim the module's
    // supa() return for one call by monkey-patching require cache.
    const path = require.resolve("../api/stats.js");
    const cached = require.cache[path];
    const auctionRow = {
      auction_id: "auc_test_001",
      ts: new Date().toISOString(),
      surface: "mcp",
      publisher_id: "dev_001",
      publisher_domain: "example.dev",
      integration_method: "mcp",
      is_sandbox: false,
      request: { host: "claude" },
      eligibility: { pool_size: 5, eligible_final: 1 },
      candidates: [{ campaign_id: "cmp_a", won: true, p_click: 0.04 }],
      winner_campaign_id: "cmp_a",
      winning_price_cpm: 3.50,
      outcome: "won",
    };
    const eventsRows = [
      { id: "ev1", event_type: "impression", created_at: "2026-05-13T01:00:00Z",
        cost: 0.0035, developer_payout: 0.002975, surface: "mcp",
        integration_method: "mcp", is_sandbox: false,
        conversion_type: null, value_cents: null, external_id: null, currency: "USD",
        ip_country: "US", ip_region: null, ip_city: null },
      { id: "ev2", event_type: "click", created_at: "2026-05-13T01:00:05Z",
        cost: 0, developer_payout: 0, integration_method: "mcp", is_sandbox: false,
        conversion_type: null, value_cents: null, external_id: null, currency: "USD" },
      { id: "ev3", event_type: "conversion", created_at: "2026-05-13T01:05:00Z",
        cost: 0, developer_payout: 0, integration_method: null, is_sandbox: false,
        conversion_type: "purchase", value_cents: 2500, external_id: "ord_xyz", currency: "USD" },
    ];
    const publisherRow = { id: "dev_001", email: "pub@example.dev", app_name: "Example Dev" };
    const campaignRow  = { id: "cmp_a", name: "Test Campaign", advertiser_id: "adv_a", cta_url: "https://example.com/buy" };
    const balanceRow   = { balance: 12.45, lifetime_earned: 80.00, lifetime_paid: 67.55 };
    const stub = makeStubSb({ auctionRow, eventsRows, publisherRow, campaignRow, balanceRow });

    // Re-require with HAS_SUPABASE flipped. Cheapest way: edit env and clear cache.
    const sbPath = require.resolve("@supabase/supabase-js");
    process.env.SUPABASE_URL = "http://stub";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
    process.env.ADMIN_TOKEN = "test_admin_token";
    require.cache[sbPath] = { exports: { createClient: () => stub }, loaded: true, id: sbPath };
    delete require.cache[path];
    const fresh2 = require("../api/stats.js");

    const { req, res } = mockReqRes({
      method: "GET",
      query: { type: "auction_inspect", id: "auc_test_001" },
      headers: { authorization: "Bearer test_admin_token" },
    });
    await fresh2(req, res);

    // Restore env + cache for subsequent tests.
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ADMIN_TOKEN;
    delete require.cache[sbPath];
    delete require.cache[path];

    assert.strictEqual(res._status, 200, `expected 200, got ${res._status}: ${JSON.stringify(res._body).slice(0, 200)}`);
    const b = res._body;
    assert(b.timeline, "response should include timeline");
    // All 8 known event types are present as keys (null when not fired).
    const expected = ["impression", "click", "close", "skip", "video_complete", "conversion", "dismiss", "error"];
    for (const k of expected) {
      assert(k in b.timeline, `timeline should contain key '${k}'`);
    }
    // The three event types we passed in are non-null with fired_at + ids.
    assert(b.timeline.impression && b.timeline.impression.fired_at, "impression should be marked fired");
    assert(b.timeline.click      && b.timeline.click.fired_at,      "click should be marked fired");
    assert(b.timeline.conversion && b.timeline.conversion.fired_at, "conversion should be marked fired");
    // Conversion value_cents → value_usd conversion is correct.
    assert.strictEqual(b.timeline.conversion.value_usd, 25.00);
    assert.strictEqual(b.timeline.conversion.conversion_type, "purchase");
    assert.strictEqual(b.timeline.conversion.external_id, "ord_xyz");
    // Engagement events we didn't pass remain null.
    assert.strictEqual(b.timeline.close, null);
    assert.strictEqual(b.timeline.video_complete, null);
    // Publisher credit summary: real impression → credited_at_impression true.
    assert.strictEqual(b.publisher_credit.credited_at_impression, true);
    assert.ok(Math.abs(b.publisher_credit.credited_amount_usd - 0.002975) < 1e-6,
      `expected ≈0.002975, got ${b.publisher_credit.credited_amount_usd}`);
    assert.strictEqual(b.publisher_credit.credit_event_id, "ev1");
    // Current snapshot was filled in from the publisher_balance row.
    assert.strictEqual(b.publisher_credit.current_balance, 12.45);
    assert.strictEqual(b.publisher_credit.lifetime_earned, 80.00);
  });

  await test("auction_inspect detail flags sandbox impressions as not-credited", async () => {
    const path = require.resolve("../api/stats.js");
    const sbPath = require.resolve("@supabase/supabase-js");

    const auctionRow = {
      auction_id: "auc_sandbox_001", ts: new Date().toISOString(),
      surface: "mcp", publisher_id: "dev_001",
      publisher_domain: "example.dev", integration_method: "mcp",
      is_sandbox: true, request: {}, eligibility: {}, candidates: [],
      winner_campaign_id: "cmp_a", winning_price_cpm: 3.50, outcome: "sandbox",
    };
    const eventsRows = [
      { id: "ev1", event_type: "impression", created_at: "2026-05-13T01:00:00Z",
        cost: 0, developer_payout: 0, surface: "mcp", integration_method: "mcp",
        is_sandbox: true, conversion_type: null, value_cents: null, external_id: null,
        currency: "USD", ip_country: "US", ip_region: null, ip_city: null },
    ];
    const stub = makeStubSb({
      auctionRow, eventsRows,
      publisherRow: { id: "dev_001", email: "pub@example.dev", app_name: "Example Dev" },
      campaignRow:  { id: "cmp_a", name: "Test", advertiser_id: "adv_a", cta_url: "https://x" },
      balanceRow:   { balance: 0, lifetime_earned: 0, lifetime_paid: 0 },
    });

    process.env.SUPABASE_URL = "http://stub";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
    process.env.ADMIN_TOKEN = "test_admin_token";
    delete require.cache[sbPath];
    require.cache[sbPath] = { exports: { createClient: () => stub }, loaded: true, id: sbPath };
    delete require.cache[path];
    const fresh = require("../api/stats.js");

    const { req, res } = mockReqRes({
      method: "GET",
      query: { type: "auction_inspect", id: "auc_sandbox_001" },
      headers: { authorization: "Bearer test_admin_token" },
    });
    await fresh(req, res);

    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ADMIN_TOKEN;
    delete require.cache[sbPath];
    delete require.cache[path];

    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.publisher_credit.credited_at_impression, false);
    assert(res._body.publisher_credit.reason_not_credited &&
           res._body.publisher_credit.reason_not_credited.toLowerCase().includes("sandbox"),
      `expected sandbox reason, got: ${res._body.publisher_credit.reason_not_credited}`);
  });

  await test("auction_inspect detail flags missing impression as not-credited", async () => {
    const path = require.resolve("../api/stats.js");
    const sbPath = require.resolve("@supabase/supabase-js");
    const stub = makeStubSb({
      auctionRow: {
        auction_id: "auc_no_imp_001", ts: new Date().toISOString(),
        surface: "mcp", publisher_id: "dev_001",
        publisher_domain: "example.dev", integration_method: "mcp",
        is_sandbox: false, request: {}, eligibility: {}, candidates: [],
        winner_campaign_id: "cmp_a", winning_price_cpm: 3.50, outcome: "won",
      },
      eventsRows: [], // no impression beacon
      publisherRow: { id: "dev_001", email: "pub@example.dev", app_name: "X" },
      campaignRow:  { id: "cmp_a", name: "Test", advertiser_id: "adv_a", cta_url: "https://x" },
      balanceRow:   { balance: 0, lifetime_earned: 0, lifetime_paid: 0 },
    });
    process.env.SUPABASE_URL = "http://stub";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
    process.env.ADMIN_TOKEN = "test_admin_token";
    delete require.cache[sbPath];
    require.cache[sbPath] = { exports: { createClient: () => stub }, loaded: true, id: sbPath };
    delete require.cache[path];
    const fresh = require("../api/stats.js");
    const { req, res } = mockReqRes({
      method: "GET",
      query: { type: "auction_inspect", id: "auc_no_imp_001" },
      headers: { authorization: "Bearer test_admin_token" },
    });
    await fresh(req, res);
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ADMIN_TOKEN;
    delete require.cache[sbPath];
    delete require.cache[path];

    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.timeline.impression, null);
    assert.strictEqual(res._body.publisher_credit.credited_at_impression, false);
    assert(res._body.publisher_credit.reason_not_credited.toLowerCase().includes("beacon"),
      `expected beacon-missing reason, got: ${res._body.publisher_credit.reason_not_credited}`);
  });

  // ── Summary ─────────────────────────────────────────────────────────
  console.log();
  if (failed) { console.log(`\x1b[31m${failed} failed\x1b[0m, ${passed} passed.`); process.exit(1); }
  else console.log(`\x1b[32m${passed} tests passed.\x1b[0m`);
})();
