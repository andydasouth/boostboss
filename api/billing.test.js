/**
 * Boost Boss — billing.js smoke test (demo-mode path).
 * Run: node api/billing.test.js
 *
 * Stripe path requires live keys — covered separately in CI with
 * STRIPE_SECRET_KEY set against test-mode keys. This file exercises every
 * code path that runs without external dependencies, which is what
 * preview deploys + investor demos hit.
 */

// Force demo mode: no Stripe, no Supabase
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const assert = require("assert");
const billing = require("./billing.js");
const ledger  = require("./_lib/ledger.js");

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
async function run(spec) { const { req, res } = mockReqRes(spec); await billing(req, res); return res; }

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log("  \x1b[32mok\x1b[0m  " + name); passed++; }
  catch (e) { console.log("  \x1b[31mFAIL\x1b[0m  " + name + ": " + e.message); failed++; if (process.env.DEBUG) console.log(e.stack); }
}

(async () => {
  console.log("BBX Billing · demo-mode smoke test\n");

  await test("HAS_STRIPE is false in demo mode", () => assert.strictEqual(billing.HAS_STRIPE, false));
  await test("x-billing-mode header set to 'demo'", async () => {
    const r = await run({ method: "GET", query: { action: "balance", id: "adv_test" } });
    assert.strictEqual(r._headers["x-billing-mode"], "demo");
  });
  await test("rejects unknown action", async () => {
    const r = await run({ method: "POST", query: { action: "wat" } });
    assert.strictEqual(r._status, 400);
  });
  await test("OPTIONS preflight returns 200", async () => {
    const r = await run({ method: "OPTIONS" });
    assert.strictEqual(r._status, 200);
  });

  // ── balance ────────────────────────────────────────────────────────
  billing._reset();
  await test("balance auto-creates demo advertiser with $5000 starting balance", async () => {
    const r = await run({ method: "GET", query: { action: "balance", id: "adv_alice" } });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.balance, 5000);
    assert.ok(r._body.company_name);
  });
  await test("balance rejects missing id", async () => {
    const r = await run({ method: "GET", query: { action: "balance" } });
    assert.strictEqual(r._status, 400);
  });

  // ── earnings ──────────────────────────────────────────────────────
  await test("earnings returns publisher revenue share derived from take rate", async () => {
    const r = await run({ method: "GET", query: { action: "earnings", key: "dev_bob" } });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.revenue_share_pct, (1 - billing.TAKE_RATE) * 100);
    assert.strictEqual(r._body.payout_threshold, 100);
  });
  await test("earnings rejects missing key", async () => {
    const r = await run({ method: "GET", query: { action: "earnings" } });
    assert.strictEqual(r._status, 400);
  });

  // ── checkout ──────────────────────────────────────────────────────
  await test("create_checkout in demo mode credits balance immediately", async () => {
    billing._reset();
    const before = await run({ method: "GET", query: { action: "balance", id: "adv_charlie" } });
    const r = await run({
      method: "POST", query: { action: "create_checkout" },
      body: { advertiser_id: "adv_charlie", amount: 250, email: "c@x.com" },
    });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.mode, "demo");
    assert.strictEqual(r._body.deposited, 250);
    assert.strictEqual(r._body.balance, before._body.balance + 250);
  });
  await test("create_checkout rejects sub-$10 deposits", async () => {
    const r = await run({
      method: "POST", query: { action: "create_checkout" },
      body: { advertiser_id: "adv_x", amount: 5, email: "x@x.com" },
    });
    assert.strictEqual(r._status, 400);
  });
  await test("create_checkout rejects missing fields", async () => {
    const r = await run({
      method: "POST", query: { action: "create_checkout" },
      body: { advertiser_id: "adv_x" },
    });
    assert.strictEqual(r._status, 400);
  });

  // ── connect ───────────────────────────────────────────────────────
  await test("create_connect issues a deterministic demo Stripe account id", async () => {
    const r = await run({
      method: "POST", query: { action: "create_connect" },
      body: { developer_id: "dev_dana", email: "dana@x.com" },
    });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.mode, "demo");
    assert.ok(r._body.stripe_account_id.startsWith("acct_demo_"));
  });

  // ── invoice generation off the ledger ─────────────────────────────
  await test("invoice sums won_price_cpm/1000 from ledger for the period", async () => {
    ledger._reset();
    billing._reset();
    // Seed three winning bids for the advertiser
    await ledger.recordAuction({ id: "auc_a", imp: [{ id: "i1" }], site: { domain: "cursor.com" } }, "seat_demo");
    const b1 = await ledger.recordBid("auc_a", { id: "bid_1", impid: "i1", price: 12.5 }, "cam_acme_001", "seat_demo");
    const b2 = await ledger.recordBid("auc_a", { id: "bid_2", impid: "i1", price: 8.0  }, "cam_acme_001", "seat_demo");
    const b3 = await ledger.recordBid("auc_a", { id: "bid_3", impid: "i1", price: 20.0 }, "cam_other_002", "seat_demo");
    await ledger.recordWin(b1.id, 12.5);
    await ledger.recordWin(b2.id, 8.0);
    await ledger.recordWin(b3.id, 20.0);

    const r = await run({
      method: "POST", query: { action: "invoice" },
      body: { advertiser_id: "adv_acme", campaign_ids: ["cam_acme_001"] },
    });
    assert.strictEqual(r._status, 200);
    // 12.5/1000 + 8/1000 = 0.0205
    assert.ok(Math.abs(r._body.invoice.subtotal_usd - 0.0205) < 1e-6, `got ${r._body.invoice.subtotal_usd}`);
    assert.strictEqual(r._body.invoice.impressions, 2);
    assert.strictEqual(r._body.invoice.line_items.length, 1);
    assert.strictEqual(r._body.invoice.line_items[0].campaign_id, "cam_acme_001");
    assert.strictEqual(r._body.invoice.status, "draft");
  });

  await test("invoice with finalize=true marks it finalized and deducts demo balance", async () => {
    ledger._reset();
    billing._reset();
    await ledger.recordAuction({ id: "auc_f", imp: [{ id: "i1" }], site: { domain: "cursor.com" } }, "seat_demo");
    const b = await ledger.recordBid("auc_f", { id: "bid_f1", impid: "i1", price: 1000 }, "cam_acme_001", "seat_demo");
    await ledger.recordWin(b.id, 1000); // 1000 CPM = $1.00 per imp

    // Top up balance first so the deduction is visible
    await run({ method: "POST", query: { action: "create_checkout" }, body: { advertiser_id: "adv_acme", amount: 50, email: "x@x.com" } });
    const balBefore = (await run({ method: "GET", query: { action: "balance", id: "adv_acme" } }))._body.balance;

    const r = await run({
      method: "POST", query: { action: "invoice" },
      body: { advertiser_id: "adv_acme", campaign_ids: ["cam_acme_001"], finalize: true },
    });
    assert.strictEqual(r._body.invoice.status, "finalized_demo");
    const balAfter = (await run({ method: "GET", query: { action: "balance", id: "adv_acme" } }))._body.balance;
    assert.ok(Math.abs((balBefore - balAfter) - r._body.invoice.total_usd) < 1e-6,
      `expected balance to drop by ${r._body.invoice.total_usd}, dropped by ${balBefore - balAfter}`);
  });

  await test("invoice with no wins returns subtotal=0", async () => {
    ledger._reset();
    billing._reset();
    const r = await run({
      method: "POST", query: { action: "invoice" },
      body: { advertiser_id: "adv_zero" },
    });
    assert.strictEqual(r._body.invoice.subtotal_usd, 0);
    assert.strictEqual(r._body.invoice.impressions, 0);
  });

  // ── payout (publisher Connect transfer) ───────────────────────────
  await test("payout splits revenue 85/15 by default and lists per-publisher transfers", async () => {
    ledger._reset();
    billing._reset();
    // Two publishers, each with one winning bid
    await ledger.recordAuction({ id: "auc_p1", imp: [{id:"i1"}], site: { domain: "cursor.com" } }, "seat_demo");
    await ledger.recordAuction({ id: "auc_p2", imp: [{id:"i1"}], site: { domain: "perplexity.ai" } }, "seat_demo");
    const b1 = await ledger.recordBid("auc_p1", { id: "bp_1", impid: "i1", price: 200000 }, "c1", "seat_demo"); // $200 worth
    const b2 = await ledger.recordBid("auc_p2", { id: "bp_2", impid: "i1", price: 100000 }, "c2", "seat_demo"); // $100 worth
    await ledger.recordWin(b1.id, 200000);
    await ledger.recordWin(b2.id, 100000);

    const r = await run({ method: "POST", query: { action: "payout" }, body: { dry_run: true } });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.publishers, 2);
    assert.strictEqual(r._body.dry_run, true);
    // Cursor: $200 gross → $170 payout (eligible). Perplexity: $100 → $85 (below $100 threshold)
    const cursor = r._body.transfers.find((t) => t.publisher === "cursor.com");
    const ppx    = r._body.transfers.find((t) => t.publisher === "perplexity.ai");
    assert.ok(Math.abs(cursor.payout_usd - 170) < 1e-6, `cursor payout: ${cursor.payout_usd}`);
    assert.strictEqual(cursor.eligible, true);
    assert.ok(Math.abs(ppx.payout_usd - 85) < 1e-6, `ppx payout: ${ppx.payout_usd}`);
    assert.strictEqual(ppx.eligible, false);
    assert.strictEqual(r._body.eligible, 1);
  });

  await test("payout returns 0 publishers when no wins in window", async () => {
    ledger._reset();
    const r = await run({ method: "POST", query: { action: "payout" }, body: { dry_run: true } });
    assert.strictEqual(r._body.publishers, 0);
    assert.strictEqual(r._body.total_payout_usd, 0);
  });

  // ── webhook ───────────────────────────────────────────────────────
  await test("webhook in demo mode accepts events but tags them untrusted", async () => {
    billing._reset();
    const r = await run({
      method: "POST", query: { action: "webhook" },
      body: { type: "checkout.session.completed", data: { object: { metadata: { advertiser_id: "adv_wh", amount: "100" } } } },
    });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r._body.received, true);
    // Balance should have been credited
    const bal = await run({ method: "GET", query: { action: "balance", id: "adv_wh" } });
    assert.strictEqual(bal._body.balance, 5100); // 5000 default + 100
  });

  await test("webhook rejects empty body", async () => {
    const r = await run({ method: "POST", query: { action: "webhook" }, body: null });
    assert.strictEqual(r._status, 400);
  });

  await test("webhook records event in audit log", async () => {
    billing._reset();
    await run({
      method: "POST", query: { action: "webhook" },
      body: { type: "payment_intent.succeeded", data: { object: {} } },
    });
    assert.strictEqual(billing._DEMO.events.length, 1);
    assert.strictEqual(billing._DEMO.events[0].type, "payment_intent.succeeded");
    assert.strictEqual(billing._DEMO.events[0].untrusted, true);
  });

  console.log();
  if (failed) { console.log(`\x1b[31m${failed} failed\x1b[0m, ${passed} passed.`); process.exit(1); }
  else console.log(`\x1b[32m${passed} checks passed.\x1b[0m`);
})();
