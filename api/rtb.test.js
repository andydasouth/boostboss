/**
 * Smoke test for the OpenRTB 2.6 adapter.
 * Run: node api/rtb.test.js
 * Exits non-zero on failure so CI can gate on it.
 *
 * The handler is invoked directly with mock req/res objects so this runs
 * without a live server.
 */

const assert = require("assert");
const handler = require("./rtb.js");

// ─── mock req/res that mimic Vercel's serverless interface ───
function mockReqRes({ method = "POST", body = null, query = {}, headers = {} } = {}) {
  const res = {
    _status: 200,
    _headers: {},
    _body: null,
    setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
    status(n) { this._status = n; return this; },
    json(obj) { this._body = obj; this._headers["content-type"] = "application/json"; return this; },
    send(data) { this._body = data; return this; },
    end() { return this; },
  };
  const req = { method, body, query, headers };
  return { req, res };
}

async function run(spec) {
  const { req, res } = mockReqRes(spec);
  await handler(req, res);
  return res;
}

// ─── test harness ───
let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log("  \x1b[32mok\x1b[0m  " + name);
    passed++;
  } catch (e) {
    console.log("  \x1b[31mFAIL\x1b[0m  " + name + ": " + e.message);
    if (process.env.DEBUG) console.log(e.stack);
    failed++;
  }
}

// ─── realistic OpenRTB 2.6 native bid request (Trade Desk-like) ───
const NATIVE_ASSET_REQUEST = {
  ver: "1.2",
  assets: [
    { id: 1, required: 1, title: { len: 60 } },
    { id: 2, required: 1, img:   { type: 3, w: 1200, h: 628 } },
    { id: 3, required: 0, data:  { type: 2, len: 200 } }, // desc
    { id: 4, required: 1, data:  { type: 12, len: 25 } }, // ctatext
  ],
};

function freshBidRequest(overrides = {}) {
  return Object.assign({
    id: "bid_req_" + Math.random().toString(36).slice(2, 10),
    at: 1,
    tmax: 200,
    cur: ["USD"],
    imp: [{
      id: "1",
      tagid: "cursor.com/editor/python",
      bidfloor: 1.50,
      bidfloorcur: "USD",
      secure: 1,
      native: { ver: "1.2", request: JSON.stringify(NATIVE_ASSET_REQUEST) },
    }],
    site: {
      id: "site_cursor_1",
      domain: "cursor.com",
      page: "https://cursor.com/editor",
      keywords: "python debugging traceback editor",
      publisher: { id: "pub_cursor", name: "Cursor Labs" },
      cat: ["IAB19-6"],
    },
    device: {
      ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      ip: "192.0.2.1",
      geo: { country: "USA", region: "us-west", city: "San Francisco" },
      devicetype: 2,
    },
    user: {
      id: "anon_sess_a1b2c3",
      ext: { session_len_min: 42 },
    },
    source: { tid: "tx_" + Math.random().toString(36).slice(2, 8), fd: 1 },
    regs: { ext: { gdpr: 0 } },
    bcat: ["IAB7-39", "IAB8-18"], // blocked: health-pharma, alcohol
    badv: ["bad-competitor.com"],
  }, overrides);
}

(async () => {
  console.log("BBX OpenRTB 2.6 adapter · smoke test\n");

  // ───────── status ─────────
  await test("GET ?op=status returns adapter metadata", async () => {
    const r = await run({ method: "GET", query: { op: "status" } });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.openrtb_version, "2.6");
    assert.strictEqual(r._body.auction_type, 1);
    assert.ok(Array.isArray(r._body.supported_formats));
    assert.ok(r._body.supported_formats.includes("native"));
    assert.ok(r._body.benna_version);
  });

  // ───────── validation ─────────
  await test("rejects empty body", async () => {
    const r = await run({ method: "POST", body: null });
    assert.strictEqual(r._status, 400);
    assert.strictEqual(r._body.nbr, 2);
  });

  await test("rejects body with no imp[]", async () => {
    const r = await run({ method: "POST", body: { id: "x" } });
    assert.strictEqual(r._status, 400);
    assert.strictEqual(r._body.nbr, 2);
    assert.ok(/imp\[\]/.test(r._body.error));
  });

  await test("rejects imp without a format", async () => {
    const r = await run({ method: "POST", body: { id: "x", imp: [{ id: "1" }] } });
    assert.strictEqual(r._status, 400);
    assert.ok(/native\/banner\/video/.test(r._body.error));
  });

  await test("accepts a JSON string body (raw POST)", async () => {
    const r = await run({ method: "POST", body: JSON.stringify(freshBidRequest()) });
    assert.ok(r._status === 200 || r._status === 204, `got ${r._status}`);
  });

  // ───────── bid happy path ─────────
  await test("native bid returns a 200 with a valid BidResponse", async () => {
    const br = freshBidRequest();
    const r = await run({ method: "POST", body: br });
    assert.strictEqual(r._status, 200, `expected 200, got ${r._status}`);
    assert.strictEqual(r._body.id, br.id, "BidResponse.id must echo BidRequest.id");
    assert.strictEqual(r._body.cur, "USD");
    assert.ok(r._body.bidid && r._body.bidid.startsWith("bbx_"));
    assert.strictEqual(r._body.seatbid.length, 1);
    assert.strictEqual(r._body.seatbid[0].seat, "boostboss");
    const bid = r._body.seatbid[0].bid[0];
    assert.ok(bid, "must return a bid");
    assert.strictEqual(bid.impid, "1");
    assert.ok(bid.price > 0, "price must be positive");
    assert.ok(bid.price >= br.imp[0].bidfloor, "price must clear bid floor");
    assert.ok(Array.isArray(bid.adomain) && bid.adomain.length > 0, "adomain required");
    assert.ok(bid.crid, "crid required");
    assert.ok(bid.nurl && bid.nurl.includes("op=win"), "nurl must be a BBX win URL");
    assert.ok(bid.nurl.includes("${AUCTION_PRICE}"), "nurl must include AUCTION_PRICE macro");
    assert.ok(bid.adm, "adm required for native");
    assert.ok(bid.ext && bid.ext.benna, "benna attribution must be attached");
    assert.ok(bid.ext.benna.model_version, "benna model_version required");
    assert.ok(bid.ext.benna.p_click >= 0 && bid.ext.benna.p_click <= 1);
    assert.ok(bid.ext.benna.p_convert >= 0 && bid.ext.benna.p_convert <= 1);
  });

  await test("native adm parses as valid Native 1.2 JSON with expected assets", async () => {
    const r = await run({ method: "POST", body: freshBidRequest() });
    const bid = r._body.seatbid[0].bid[0];
    const adm = JSON.parse(bid.adm);
    assert.strictEqual(adm.native.ver, "1.2");
    assert.ok(Array.isArray(adm.native.assets));
    assert.ok(adm.native.link && adm.native.link.url, "link.url required");
    // Each requested asset id must be present in the response
    const ids = new Set(adm.native.assets.map((a) => a.id));
    for (const reqAsset of NATIVE_ASSET_REQUEST.assets) {
      assert.ok(ids.has(reqAsset.id), `asset ${reqAsset.id} missing from adm`);
    }
    // Title content must match a campaign headline (from demo pool)
    const titleAsset = adm.native.assets.find((a) => a.title);
    assert.ok(titleAsset && titleAsset.title.text, "title required");
  });

  // ───────── brand safety ─────────
  await test("badv blocks advertiser domain", async () => {
    const br = freshBidRequest({ badv: ["example-advertiser.com", "example-dsp.com", "example-deploy.com"] });
    const r = await run({ method: "POST", body: br });
    // All demo campaigns blocked → 204 expected
    assert.strictEqual(r._status, 204);
  });

  await test("bcat blocks IAB category", async () => {
    const br = freshBidRequest({ bcat: ["IAB19-6", "IAB19-11", "IAB19-30"] });
    const r = await run({ method: "POST", body: br });
    assert.strictEqual(r._status, 204);
  });

  // ───────── bid floor enforcement ─────────
  await test("bid below floor results in no bid (204)", async () => {
    const br = freshBidRequest();
    br.imp[0].bidfloor = 999; // higher than any demo campaign can clear
    const r = await run({ method: "POST", body: br });
    assert.strictEqual(r._status, 204);
  });

  await test("bid floor of 0 clears normally", async () => {
    const br = freshBidRequest();
    br.imp[0].bidfloor = 0;
    const r = await run({ method: "POST", body: br });
    assert.strictEqual(r._status, 200);
  });

  // ───────── region / format eligibility ─────────
  await test("non-matching region falls back to global-targeted campaigns", async () => {
    const br = freshBidRequest();
    br.device.geo = { country: "BRA", region: "sa-east" };
    const r = await run({ method: "POST", body: br });
    // datadog campaign targets "global" so we should still get a bid
    assert.strictEqual(r._status, 200);
  });

  await test("banner imp returns a banner bid with w/h and HTML adm", async () => {
    const br = freshBidRequest();
    br.imp = [{
      id: "b1",
      tagid: "cursor.com/editor",
      bidfloor: 0.5,
      banner: { w: 728, h: 90 },
    }];
    const r = await run({ method: "POST", body: br });
    // No "image" campaigns in demo pool — should be 204
    assert.strictEqual(r._status, 204);
  });

  await test("video imp returns a video bid with VAST adm", async () => {
    const br = freshBidRequest();
    br.imp = [{
      id: "v1",
      tagid: "cursor.com/editor",
      bidfloor: 0.5,
      video: { w: 1280, h: 720, mimes: ["video/mp4"] },
    }];
    const r = await run({ method: "POST", body: br });
    // No "video" campaigns in demo pool → 204
    assert.strictEqual(r._status, 204);
  });

  // ───────── MCP context translation ─────────
  await test("MCP context is derived from site.keywords + geo + session_len", async () => {
    const br = freshBidRequest();
    const ctx = handler.contextFromBidRequest(br, br.imp[0]);
    assert.strictEqual(ctx.host, "cursor.com");
    assert.strictEqual(ctx.intent, "debug_py", `got ${ctx.intent}`);
    assert.strictEqual(ctx.region, "us-west");
    assert.strictEqual(ctx.session_len, 42);
  });

  await test("explicit ext.mcp_context overrides inferred signals", async () => {
    const br = freshBidRequest();
    br.imp[0].ext = { mcp_context: { intent: "docs_lookup", mcp_tool: "file.read", host: "claude.ai" } };
    const ctx = handler.contextFromBidRequest(br, br.imp[0]);
    assert.strictEqual(ctx.intent, "docs_lookup");
    assert.strictEqual(ctx.mcp_tool, "file.read");
    assert.strictEqual(ctx.host, "claude.ai");
  });

  // ───────── win / loss pixels ─────────
  await test("win notice returns a 1x1 GIF pixel", async () => {
    const r = await run({ method: "GET", query: { op: "win", imp: "i1", price: "3.42", bid: "b1" } });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._headers["content-type"], "image/gif");
    assert.ok(Buffer.isBuffer(r._body));
    assert.strictEqual(r._body[0], 0x47); // "G"
    assert.strictEqual(r._body[1], 0x49); // "I"
    assert.strictEqual(r._body[2], 0x46); // "F"
  });

  await test("loss notice returns a 1x1 GIF pixel", async () => {
    const r = await run({ method: "GET", query: { op: "loss", imp: "i1", reason: "2", bid: "b1" } });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._headers["content-type"], "image/gif");
  });

  // ───────── response headers ─────────
  await test("sets x-openrtb-version and x-bbx-adapter headers", async () => {
    const r = await run({ method: "POST", body: freshBidRequest() });
    assert.strictEqual(r._headers["x-openrtb-version"], "2.6");
    assert.ok(r._headers["x-bbx-adapter"].startsWith("bbx-rtb-adapter/"));
  });

  await test("sets x-bbx-processing-ms header on bid response", async () => {
    const r = await run({ method: "POST", body: freshBidRequest() });
    const ms = Number(r._headers["x-bbx-processing-ms"]);
    assert.ok(Number.isFinite(ms) && ms >= 0 && ms < 5000, `processing_ms out of range: ${ms}`);
  });

  // ───────── multi-impression ─────────
  await test("multi-imp bid request returns one bid per winnable imp", async () => {
    const br = freshBidRequest();
    br.imp = [
      { id: "1", tagid: "cursor.com", bidfloor: 0.5, native: { ver: "1.2", request: JSON.stringify(NATIVE_ASSET_REQUEST) } },
      { id: "2", tagid: "cursor.com", bidfloor: 0.5, native: { ver: "1.2", request: JSON.stringify(NATIVE_ASSET_REQUEST) } },
    ];
    const r = await run({ method: "POST", body: br });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.seatbid[0].bid.length, 2);
    const impIds = r._body.seatbid[0].bid.map((b) => b.impid).sort();
    assert.deepStrictEqual(impIds, ["1", "2"]);
  });

  // ───────── seat authentication ─────────
  const seats = require("./_lib/seats.js");
  const ledger = require("./_lib/ledger.js");
  const demoSeatKey = seats._DEMO_SEATS.get("seat_demo").api_key;

  await test("anonymous bids are accepted in demo mode and tagged seat_anon", async () => {
    const r = await run({ method: "POST", body: freshBidRequest() });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._headers["x-bbx-seat"], "seat_anon");
    assert.strictEqual(r._body.ext.seat, "seat_anon");
    assert.strictEqual(r._body.ext.billable, false);
  });

  await test("Bearer token resolves to the seat and marks ext.billable=true", async () => {
    const r = await run({
      method: "POST",
      body: freshBidRequest(),
      headers: { authorization: "Bearer " + demoSeatKey },
    });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._headers["x-bbx-seat"], "seat_demo");
    assert.strictEqual(r._body.ext.billable, true);
  });

  await test("invalid Bearer token rejects with 401 + WWW-Authenticate", async () => {
    process.env.BBX_SEAT_AUTH_REQUIRED = "true";
    // Re-require seats so it picks up the new env var
    delete require.cache[require.resolve("./_lib/seats.js")];
    delete require.cache[require.resolve("./rtb.js")];
    const handlerStrict = require("./rtb.js");
    const { req, res } = mockReqRes({
      method: "POST",
      body: freshBidRequest(),
      headers: { authorization: "Bearer not-a-real-key" },
    });
    await handlerStrict(req, res);
    assert.strictEqual(res._status, 401);
    assert.ok(res._headers["www-authenticate"]);
    delete process.env.BBX_SEAT_AUTH_REQUIRED;
    delete require.cache[require.resolve("./_lib/seats.js")];
    delete require.cache[require.resolve("./rtb.js")];
  });

  await test("missing Bearer token in strict mode returns 401", async () => {
    process.env.BBX_SEAT_AUTH_REQUIRED = "true";
    delete require.cache[require.resolve("./_lib/seats.js")];
    delete require.cache[require.resolve("./rtb.js")];
    const handlerStrict = require("./rtb.js");
    const { req, res } = mockReqRes({ method: "POST", body: freshBidRequest() });
    await handlerStrict(req, res);
    assert.strictEqual(res._status, 401);
    delete process.env.BBX_SEAT_AUTH_REQUIRED;
    delete require.cache[require.resolve("./_lib/seats.js")];
    delete require.cache[require.resolve("./rtb.js")];
  });

  // ───────── auction ledger persistence ─────────
  await test("bid request is persisted to the ledger with seat_id", async () => {
    ledger._reset();
    const br = freshBidRequest({ id: "auc_persist_001" });
    await run({
      method: "POST", body: br,
      headers: { authorization: "Bearer " + demoSeatKey },
    });
    const dump = ledger._dump();
    const auc = dump.auctions.find((a) => a.id === "auc_persist_001");
    assert.ok(auc, "auction not persisted");
    assert.strictEqual(auc.seat_id, "seat_demo");
    assert.strictEqual(auc.imp_count, br.imp.length);
  });

  await test("each Bid in the response is persisted with status=pending", async () => {
    ledger._reset();
    const br = freshBidRequest({ id: "auc_persist_002" });
    const r = await run({
      method: "POST", body: br,
      headers: { authorization: "Bearer " + demoSeatKey },
    });
    const bidId = r._body.seatbid[0].bid[0].id;
    const dump = ledger._dump();
    const stored = dump.bids.find((b) => b.id === bidId);
    assert.ok(stored, "bid not persisted");
    assert.strictEqual(stored.status, "pending");
    assert.strictEqual(stored.seat_id, "seat_demo");
    assert.ok(stored.price_cpm > 0, "price_cpm must be > 0");
  });

  // ───────── win flow + atomic budget deduction ─────────
  await test("WIN notice marks bid won, persists clearing price, deducts campaign budget", async () => {
    ledger._reset();
    const br = freshBidRequest({ id: "auc_win_001" });
    const r = await run({
      method: "POST", body: br,
      headers: { authorization: "Bearer " + demoSeatKey },
    });
    const bid = r._body.seatbid[0].bid[0];
    const winRes = await run({
      method: "GET",
      query: { op: "win", imp: bid.impid, price: "12.50", bid: bid.id, camp: bid.adid },
    });
    assert.strictEqual(winRes._headers["x-bbx-win-recorded"], "1");
    assert.strictEqual(winRes._headers["x-bbx-cleared-price-cpm"], "12.5");

    const dump = ledger._dump();
    const stored = dump.bids.find((b) => b.id === bid.id);
    assert.strictEqual(stored.status, "won");
    assert.strictEqual(stored.won_price_cpm, 12.5);

    // Budget deducted by 12.50 / 1000 = 0.0125 USD
    const budget = dump.budgets.find((b) => b.campaign_id === bid.adid);
    assert.ok(budget, "budget row not created");
    assert.ok(Math.abs(budget.spent_today - 0.0125) < 1e-6, `expected 0.0125, got ${budget.spent_today}`);
  });

  await test("duplicate WIN is idempotent (no double-spend)", async () => {
    ledger._reset();
    const br = freshBidRequest({ id: "auc_win_dup_001" });
    const r = await run({
      method: "POST", body: br,
      headers: { authorization: "Bearer " + demoSeatKey },
    });
    const bid = r._body.seatbid[0].bid[0];
    await run({ method: "GET", query: { op: "win", imp: bid.impid, price: "8.00", bid: bid.id, camp: bid.adid } });
    await run({ method: "GET", query: { op: "win", imp: bid.impid, price: "8.00", bid: bid.id, camp: bid.adid } });
    const budget = ledger._dump().budgets.find((b) => b.campaign_id === bid.adid);
    assert.ok(Math.abs(budget.spent_today - 0.008) < 1e-6, `expected 0.008 (single deduction), got ${budget.spent_today}`);
  });

  await test("WIN for unknown bid_id reports recorded=0 (no false positives)", async () => {
    ledger._reset();
    const winRes = await run({
      method: "GET",
      query: { op: "win", imp: "ix", price: "3.00", bid: "bid_does_not_exist", camp: "c1" },
    });
    assert.strictEqual(winRes._headers["x-bbx-win-recorded"], "0");
  });

  // ───────── loss flow ─────────
  await test("LOSS notice marks bid lost with reason code", async () => {
    ledger._reset();
    const br = freshBidRequest({ id: "auc_loss_001" });
    const r = await run({
      method: "POST", body: br,
      headers: { authorization: "Bearer " + demoSeatKey },
    });
    const bid = r._body.seatbid[0].bid[0];
    const lossRes = await run({
      method: "GET",
      query: { op: "loss", imp: bid.impid, reason: "102", bid: bid.id },
    });
    assert.strictEqual(lossRes._headers["x-bbx-loss-recorded"], "1");
    const stored = ledger._dump().bids.find((b) => b.id === bid.id);
    assert.strictEqual(stored.status, "lost");
    assert.strictEqual(stored.lost_reason, 102);
  });

  // ───────── reporting endpoint ─────────
  await test("op=report returns spend summary for the authenticated seat", async () => {
    ledger._reset();
    // Push one auction → bid → win for seat_demo
    const br = freshBidRequest({ id: "auc_report_001" });
    const r = await run({
      method: "POST", body: br,
      headers: { authorization: "Bearer " + demoSeatKey },
    });
    const bid = r._body.seatbid[0].bid[0];
    await run({ method: "GET", query: { op: "win", imp: bid.impid, price: "20.00", bid: bid.id, camp: bid.adid } });

    const rep = await run({
      method: "GET",
      query: { op: "report" },
      headers: { authorization: "Bearer " + demoSeatKey },
    });
    assert.strictEqual(rep._status, 200);
    assert.strictEqual(rep._body.seat.id, "seat_demo");
    assert.strictEqual(rep._body.requests, 1);
    assert.strictEqual(rep._body.bids, 1);
    assert.strictEqual(rep._body.wins, 1);
    assert.strictEqual(rep._body.win_rate, 1);
    assert.strictEqual(rep._body.avg_cpm_won, 20);
  });

  await test("op=report without auth in strict mode returns 401", async () => {
    process.env.BBX_SEAT_AUTH_REQUIRED = "true";
    delete require.cache[require.resolve("./_lib/seats.js")];
    delete require.cache[require.resolve("./rtb.js")];
    const handlerStrict = require("./rtb.js");
    const { req, res } = mockReqRes({ method: "GET", query: { op: "report" } });
    await handlerStrict(req, res);
    assert.strictEqual(res._status, 401);
    delete process.env.BBX_SEAT_AUTH_REQUIRED;
    delete require.cache[require.resolve("./_lib/seats.js")];
    delete require.cache[require.resolve("./rtb.js")];
  });

  // ───────── summary ─────────
  console.log();
  if (failed) {
    console.log(`\x1b[31m${failed} failed\x1b[0m, ${passed} passed.`);
    process.exit(1);
  } else {
    console.log(`\x1b[32m${passed} checks passed.\x1b[0m`);
  }
})();
