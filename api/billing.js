/**
 * Boost Boss — Billing API
 *
 * Two execution modes mirror the auth + ledger pattern:
 *   • PRODUCTION — live Stripe (when STRIPE_SECRET_KEY is set)
 *   • DEMO       — in-process accounts/transfers/invoices, perfect for
 *                  preview deploys, the public exchange page, and the
 *                  test suite. No external calls, deterministic responses.
 *
 * Endpoints
 *   POST /api/billing?action=create_checkout    advertiser deposits funds
 *   POST /api/billing?action=invoice            generate an invoice from the
 *                                                ledger for an advertiser
 *                                                (sum of won_price_cpm / 1000
 *                                                over the period)
 *   POST /api/billing?action=webhook            Stripe webhook handler
 *                                                (signature-verified)
 *   GET  /api/billing?action=balance&id=...     advertiser balance
 *   GET  /api/billing?action=history&id=...     advertiser tx history
 *   GET  /api/billing?action=earnings&key=...   developer earnings
 *
 * Money model (updated 2026-06-04)
 *   • RTB exchange fee:    6.5% (configurable via BBX_RTB_FEE)      — demand-side, charged to advertiser
 *   • Network take:       23.5% (configurable via BBX_NETWORK_TAKE) — Boost Boss platform margin
 *   • Combined fees:        30% (BBX_RTB_FEE + BBX_NETWORK_TAKE)
 *   • Publisher share:      70% (1 - BBX_RTB_FEE - BBX_NETWORK_TAKE)
 *   • Legacy BBX_TAKE_RATE  — if set, overrides the sum of the two new vars (back-compat)
 *   • Currency:             USD only for v1
 *
 * Cash-OUT removed (2026-07-06): publishers earn CREDITS only. All payout
 * actions, the weekly payout crons, Stripe Connect onboarding/transfers and
 * PayPal Payouts webhook handling were deleted. Cash flows IN only.
 */

const ledger = require("./_lib/ledger.js");
// Phase 2 — PayPal pay-in rail (additive; demo-mode safe when env unset).
const paypal = require("./_lib/payin/paypal.js");

const HAS_STRIPE   = !!process.env.STRIPE_SECRET_KEY;
const HAS_PAYPAL   = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const HAS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
);

// Which pay-in provider the advertiser dashboard should default to.
// "auto" picks PayPal if configured, else Stripe, else demo.
const PAYIN_PROVIDER_ENV = (process.env.PAYIN_PROVIDER || "auto").toLowerCase();
function resolvedPayinProvider() {
  if (PAYIN_PROVIDER_ENV === "paypal") return HAS_PAYPAL ? "paypal" : "demo";
  if (PAYIN_PROVIDER_ENV === "stripe") return HAS_STRIPE ? "stripe" : "demo";
  // auto
  if (HAS_PAYPAL) return "paypal";
  if (HAS_STRIPE) return "stripe";
  return "demo";
}

// Revenue model split (Phase F, 2026-06-04). Each fee is kept as a separate
// env var so they can be tuned independently AND attributed correctly in
// accounting (RTB is invoiced to the advertiser as a demand-side fee; the
// network take is platform margin). Legacy BBX_TAKE_RATE still wins if set,
// for back-compat with anything still pointing at the old single-knob name.
const RTB_FEE           = Number(process.env.BBX_RTB_FEE)      || 0.065;
const NETWORK_TAKE      = Number(process.env.BBX_NETWORK_TAKE) || 0.235;
const TAKE_RATE         = Number(process.env.BBX_TAKE_RATE)
                          || +(RTB_FEE + NETWORK_TAKE).toFixed(6); // 0.30 default
const PUBLIC_BASE_URL    = process.env.BOOSTBOSS_BASE_URL     || "https://boostboss.ai";
const STRIPE_WEBHOOK_KEY = process.env.STRIPE_WEBHOOK_SECRET   || null;

// ── Startup safety: warn loudly if production infra is partially configured ──
if (HAS_SUPABASE && !HAS_STRIPE) {
  console.error("⚠️  [Billing] CRITICAL: Supabase is configured but STRIPE_SECRET_KEY is missing. Billing will run in DEMO mode — real deposits will NOT be processed. Set STRIPE_SECRET_KEY to enable production billing.");
}
if (HAS_STRIPE && !STRIPE_WEBHOOK_KEY) {
  console.error("⚠️  [Billing] WARNING: Stripe is configured but STRIPE_WEBHOOK_SECRET is missing. Webhooks will be rejected in production. Deposits may not credit advertiser balances.");
}
if (HAS_STRIPE && !HAS_SUPABASE) {
  console.error("⚠️  [Billing] WARNING: Stripe is configured but Supabase is missing. Payments will process but balances cannot be persisted.");
}

// ── lazy loaders so demo mode has zero deps ────────────────────────────
let _stripe = null;
function stripe() {
  if (_stripe) return _stripe;
  if (!HAS_STRIPE) return null;
  try { _stripe = require("stripe")(process.env.STRIPE_SECRET_KEY); }
  catch (_) { console.warn("[Billing] stripe SDK not installed — falling back to demo mode"); }
  return _stripe;
}

let _supabase = null;
function supa() {
  if (_supabase) return _supabase;
  if (!HAS_SUPABASE) return null;
  try {
    const { createClient } = require("@supabase/supabase-js");
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    );
    return _supabase;
  } catch (_) { return null; }
}

// Anon-keyed client used only for validating user-supplied JWTs via
// supabase.auth.getUser(token). The service-role client above can't be
// used for this because it bypasses RLS and would happily return the
// service-role identity for any input.
let _supabaseAnon = null;
function supaAnon() {
  if (_supabaseAnon) return _supabaseAnon;
  if (!process.env.SUPABASE_URL) return null;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || "";
  if (!anonKey) return null;
  try {
    const { createClient } = require("@supabase/supabase-js");
    _supabaseAnon = createClient(process.env.SUPABASE_URL, anonKey, {
      auth: { persistSession: false },
    });
    return _supabaseAnon;
  } catch (_) { return null; }
}

// Extract the authenticated user from the Authorization: Bearer <jwt>
// header. Returns the Supabase user object, or null if the header is
// missing / malformed / expired. Used by tenant-scoped routes that
// previously trusted `?id=` from the query string — see task #152.
async function getAuthUser(req) {
  const token = (req.headers && req.headers.authorization || "")
    .replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const anon = supaAnon();
  if (!anon) return null;
  try {
    const { data, error } = await anon.auth.getUser(token);
    if (error || !data || !data.user) return null;
    return data.user;
  } catch (_) { return null; }
}

// ── In-process demo accounts (reset on cold start) ─────────────────────
const DEMO = {
  advertisers: new Map(), // id → { id, email, balance, company_name }
  developers:  new Map(), // id → { id, email, total_earnings, app_name, stripe_account_id }
  invoices:    new Map(), // id → invoice record
  events:      [],        // append-only event log (mirrors webhook events)
  processedWebhookIds: new Set(), // idempotency guard for webhook events
};

function ensureDemoAdvertiser(id, extras = {}) {
  let a = DEMO.advertisers.get(id);
  if (!a) {
    a = { id, email: extras.email || `${id}@example.com`,
          balance: extras.balance != null ? extras.balance : 5000,
          company_name: extras.company_name || "Demo Co.",
          created_at: new Date().toISOString() };
    DEMO.advertisers.set(id, a);
  }
  return a;
}
function ensureDemoDeveloper(id, extras = {}) {
  let d = DEMO.developers.get(id);
  if (!d) {
    d = { id, email: extras.email || `${id}@example.com`,
          total_earnings: extras.total_earnings || 0,
          app_name: extras.app_name || "Demo App",
          stripe_account_id: extras.stripe_account_id || null,
          created_at: new Date().toISOString() };
    DEMO.developers.set(id, d);
  }
  return d;
}

// ────────────────────────────────────────────────────────────────────────
//                                HANDLER
// ────────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Restrict CORS in production to BoostBoss origins only; allow * in demo for local dev
  const allowedOrigins = HAS_STRIPE
    ? ["https://boostboss.ai", "https://www.boostboss.ai", PUBLIC_BASE_URL]
    : ["*"];
  const origin = req.headers && req.headers.origin;
  if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else {
    res.setHeader("Access-Control-Allow-Origin", PUBLIC_BASE_URL);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Stripe-Signature, PayPal-Transmission-Id, PayPal-Transmission-Time, PayPal-Transmission-Sig, PayPal-Cert-Url, PayPal-Auth-Algo");
  res.setHeader("x-billing-mode", HAS_STRIPE ? "stripe" : "demo");
  res.setHeader("x-payin-provider", resolvedPayinProvider());
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = (req.query && req.query.action) || (req.body && req.body.action);

  try {
    switch (action) {
      case "balance":         return await handleBalance(req, res);
      case "earnings":        return await handleEarnings(req, res);
      case "create_checkout": return await handleCreateCheckout(req, res);
      // Phase E Day 5 — E2E inventory diagnostic. Returns the count and
      // most-recent timestamp at every checkpoint of the funnel.
      case "e2e_inventory":           return await handleE2EInventory(req, res);
      // Phase F — per-door integration verification. Returns whether each
      // of the four doors (mcp, js-snippet, npm-sdk, rest-api) has fired
      // any event for this publisher in the last 24h. Powers the
      // onboarding wizard's live "Verify" check.
      case "integration_verify":      return await handleIntegrationVerify(req, res);
      case "invoice":         return await handleInvoice(req, res);
      case "history":         return await handleHistory(req, res);
      case "webhook":         return await handleWebhook(req, res);
      // ── Phase 2 — PayPal pay-in rail ───────────────────────────────
      // Frontends should switch to these once PAYIN_PROVIDER=paypal.
      // create_paypal_order returns an approval_url the dashboard
      // sends the advertiser to; capture_paypal_order is called from
      // the return URL with the order id PayPal echoes back.
      case "create_paypal_order":   return await handleCreatePaypalOrder(req, res);
      case "capture_paypal_order":  return await handleCapturePaypalOrder(req, res);
      case "paypal_order_status":   return await handlePaypalOrderStatus(req, res);
      case "paypal_refund":         return await handlePaypalRefund(req, res);
      case "paypal_webhook":        return await handlePaypalWebhook(req, res);
      case "payin_provider":        return res.json({ provider: resolvedPayinProvider(), has_stripe: HAS_STRIPE, has_paypal: HAS_PAYPAL });
      default:                return res.status(400).json({ error: "Unknown action" });
    }
  } catch (err) {
    console.error("[Billing Error]", err);
    return res.status(500).json({ error: err.message });
  }
};

// ── balance ────────────────────────────────────────────────────────────
//
// Task #152 hardening: previously trusted ?id= from the query string. Any
// signed-in user could read any other tenant's balance. Now requires a
// valid Bearer JWT and ignores any caller-supplied id — the authenticated
// user's id IS the advertiser scope. Demo-mode fallback (no Supabase)
// still uses the query id because demo data is throwaway by definition.
async function handleBalance(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const sb = supa();
  if (sb) {
    const user = await getAuthUser(req);
    if (!user) {
      return res.status(401).json({ error: "Missing or invalid Authorization header" });
    }
    const { data, error } = await sb.from("advertisers")
      .select("balance, company_name").eq("id", user.id).single();
    if (error) return res.status(404).json({ error: "Advertiser not found" });
    return res.json({ balance: Number(data.balance), company_name: data.company_name });
  }

  // Demo mode — no Supabase configured. Keep the old query-id behavior
  // so the in-process demo state still works for preview deploys.
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Missing advertiser id" });
  const a = ensureDemoAdvertiser(id);
  return res.json({ balance: a.balance, company_name: a.company_name });
}

// ── history ───────────────────────────────────────────────────────────
//
// Task #152 hardening: same model as handleBalance — JWT-derived
// advertiser id in production, fall back to query id only when no
// Supabase is configured (demo mode).
async function handleHistory(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const sb = supa();
  let id;
  if (sb) {
    const user = await getAuthUser(req);
    if (!user) {
      return res.status(401).json({ error: "Missing or invalid Authorization header" });
    }
    id = user.id;
    // Attempt to read from a transactions table if it exists
    try {
      const { data, error } = await sb.from("transactions")
        .select("*").eq("advertiser_id", id).order("created_at", { ascending: false }).limit(50);
      if (!error && data) return res.json({ transactions: data });
    } catch (_) { /* table may not exist — fall through to demo */ }
  } else {
    id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: "Missing advertiser id" });
  }

  // Demo mode — build real history from ledger + track events + demo deposits
  const a = ensureDemoAdvertiser(id);
  const now = Date.now();
  const transactions = [];

  // Pull real spend from track events
  try {
    const trackEvents = require("./track.js")._DEMO_EVENTS || [];
    for (const ev of trackEvents) {
      if (ev.cost > 0) {
        // Match events to this advertiser's campaigns
        let camps;
        try { camps = require("./campaigns.js")._DEMO_CAMPAIGNS || new Map(); } catch (_) { camps = new Map(); }
        const camp = typeof camps.get === "function" ? camps.get(ev.campaign_id) : null;
        if (camp && camp.advertiser_id === id) {
          transactions.push({
            date: ev.created_at, description: `Ad spend: ${camp.name || ev.campaign_id}`,
            type: "spend", amount: -ev.cost, status: "settled",
          });
        }
      }
    }
  } catch (_) {}

  // Add seeded history if no real events exist
  if (transactions.length === 0) {
    transactions.push(
      { date: new Date(now - 86400000).toISOString(), description: "Campaign spend", type: "spend", amount: -42.18, status: "settled" },
      { date: new Date(now - 86400000 * 2).toISOString(), description: "Campaign spend", type: "spend", amount: -28.50, status: "settled" },
    );
  }

  // Always show a recent deposit
  transactions.push({
    date: new Date(now - 86400000 * 3).toISOString(), description: "Deposit via Stripe",
    type: "deposit", amount: 500.00, status: "completed",
  });

  // Sort descending and add running balance
  transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
  let bal = a.balance;
  for (const tx of transactions) {
    tx.balance = +bal.toFixed(2);
    bal -= tx.amount; // reverse the transaction to compute prior balance
  }

  return res.json({ transactions });
}

// ── earnings ───────────────────────────────────────────────────────────
async function handleEarnings(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: "Missing developer api key" });

  const sb = supa();
  if (sb) {
    const { data: dev } = await sb.from("developers")
      .select("id, total_earnings, app_name, revenue_share_pct")
      .eq("api_key", key).single();
    if (!dev) return res.status(404).json({ error: "Developer not found" });
    const { data: pending } = await sb.from("events")
      .select("developer_payout").eq("developer_id", dev.id).gt("developer_payout", 0);
    const pendingTotal = (pending || []).reduce((s, e) => { const v = parseFloat(e.developer_payout || 0); return s + (Number.isFinite(v) ? v : 0); }, 0);
    return res.json({
      app_name: dev.app_name, total_earnings: dev.total_earnings,
      pending_payout: pendingTotal.toFixed(2),
      revenue_share_pct: dev.revenue_share_pct,
    });
  }
  // Demo path: derive earnings from ledger + track events so numbers are real
  const dev = ensureDemoDeveloper(key, { app_name: "My AI App" });
  // Sum developer_payout from in-memory track events
  let pendingPayout = 0;
  try {
    const trackEvents = require("./track.js")._DEMO_EVENTS || [];
    for (const ev of trackEvents) {
      if (ev.developer_id === key && ev.developer_payout > 0) {
        pendingPayout += ev.developer_payout;
      }
    }
  } catch (_) {}
  // Also check ledger wins attributed to this developer
  try {
    const dump = ledger._dump();
    for (const bid of dump.bids) {
      if (bid.status === "won" && bid.developer_id === key) {
        pendingPayout += (Number(bid.won_price_cpm) || 0) / 1000 * (1 - TAKE_RATE);
      }
    }
  } catch (_) {}
  const totalEarnings = dev.total_earnings + pendingPayout;
  return res.json({
    app_name: dev.app_name, total_earnings: totalEarnings.toFixed(2),
    pending_payout: pendingPayout.toFixed(2), revenue_share_pct: (1 - TAKE_RATE) * 100,
  });
}

// ── advertiser deposit (Stripe Checkout) ───────────────────────────────
async function handleCreateCheckout(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { advertiser_id, amount, email } = req.body || {};
  if (!advertiser_id || !amount) return res.status(400).json({ error: "Missing advertiser_id or amount" });
  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount < 10) return res.status(400).json({ error: "Minimum deposit is $10" });
  if (parsedAmount > 100000) return res.status(400).json({ error: "Maximum single deposit is $100,000" });

  const s = stripe();
  if (!s) {
    // Demo mode — credit the balance immediately so the dashboard reflects the deposit
    const a = ensureDemoAdvertiser(advertiser_id, { email });
    a.balance += Number(amount);
    return res.json({
      mode: "demo", checkout_url: null,
      message: "Demo mode — balance credited locally; no real charge.",
      balance: a.balance, deposited: Number(amount),
    });
  }

  const session = await s.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: {
          name: "Boost Boss Ad Credits",
          description: `$${amount} deposit to your Boost Boss ad account`,
        },
        unit_amount: Math.round(Number(amount) * 100),
      },
      quantity: 1,
    }],
    mode: "payment",
    success_url: `${PUBLIC_BASE_URL}/advertiser?deposit=success&amount=${amount}`,
    cancel_url:  `${PUBLIC_BASE_URL}/advertiser?deposit=cancelled`,
    customer_email: email,
    metadata: { advertiser_id, amount: String(amount) },
  });
  return res.json({ mode: "stripe", checkout_url: session.url, session_id: session.id });
}

// ────────────────────────────────────────────────────────────────────
// ── Phase 2 — PayPal pay-in ─────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────
//
// Three-step flow that mirrors the Stripe Checkout pattern but routes
// money through PayPal instead:
//
//   1. create_paypal_order  → backend creates a PayPal order, returns
//                              the approval URL. Frontend redirects.
//   2. (user approves on PayPal)
//   3. capture_paypal_order → return URL hits this with the order id,
//                              backend captures the funds and credits
//                              the advertiser balance.
//
// paypal_webhook acts as the durable confirmation channel for
// asynchronous capture/refund events so an interrupted return-URL
// hop never leaves money in an unaccounted state.

const PAYPAL_MIN_DEPOSIT_USD = 10;
const PAYPAL_MAX_DEPOSIT_USD = 100000;

async function handleCreatePaypalOrder(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { advertiser_id, amount, email } = req.body || {};
  if (!advertiser_id || amount == null) {
    return res.status(400).json({ error: "Missing advertiser_id or amount" });
  }
  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount < PAYPAL_MIN_DEPOSIT_USD) {
    return res.status(400).json({ error: `Minimum deposit is $${PAYPAL_MIN_DEPOSIT_USD}` });
  }
  if (parsedAmount > PAYPAL_MAX_DEPOSIT_USD) {
    return res.status(400).json({ error: `Maximum single deposit is $${PAYPAL_MAX_DEPOSIT_USD}` });
  }

  // Always ensure the demo advertiser record exists so the capture step
  // can find it even when running against the in-memory ledger.
  if (!HAS_SUPABASE) ensureDemoAdvertiser(advertiser_id, { email });

  let order;
  try {
    order = await paypal.createOrder({
      advertiserId: advertiser_id,
      amountUsd:    parsedAmount,
      email,
      returnUrl:    `${PUBLIC_BASE_URL}/advertiser?deposit=paypal_return&advertiser_id=${encodeURIComponent(advertiser_id)}&amount=${parsedAmount}`,
      cancelUrl:    `${PUBLIC_BASE_URL}/advertiser?deposit=cancelled`,
      // PayPal-Request-Id idempotency: tie to advertiser + amount + minute
      // so a double-click within the same minute returns the same order.
      requestId:    `bb_payin_${advertiser_id}_${Math.round(parsedAmount * 100)}_${Math.floor(Date.now() / 60000)}`,
    });
  } catch (err) {
    console.error("[Billing] paypal createOrder failed:", err.message, err.detail || "");
    return res.status(502).json({ error: "paypal_create_failed", detail: err.message });
  }

  // Stamp a pending transaction so we can correlate the capture later.
  const sb = supa();
  if (sb && order.mode === "paypal") {
    try {
      await sb.from("transactions").insert({
        advertiser_id, type: "deposit",
        amount: parsedAmount,
        description: "PayPal deposit (pending capture)",
        paypal_order_id: order.order_id,
        provider:        "paypal",
        status:          "pending",
      });
    } catch (_) { /* transactions table may lack new columns yet — surface in webhook */ }
  }

  return res.json({
    mode:         order.mode,
    provider:     "paypal",
    order_id:     order.order_id,
    approval_url: order.approval_url,
    amount:       parsedAmount,
  });
}

async function handleCapturePaypalOrder(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const orderId =
    (req.body && req.body.order_id) ||
    (req.query && req.query.order_id) ||
    (req.query && req.query.token); // PayPal sends `token=<orderId>` on return
  if (!orderId) return res.status(400).json({ error: "Missing order_id" });
  const expectedAdvertiserId = (req.body && req.body.advertiser_id) || (req.query && req.query.advertiser_id) || null;
  const expectedAmount       = Number((req.body && req.body.amount) || (req.query && req.query.amount) || 0) || undefined;

  let capture;
  try {
    capture = await paypal.captureOrder(orderId, {
      expectedAmountUsd: expectedAmount,
      requestId:         `bb_capture_${orderId}`,
    });
  } catch (err) {
    console.error("[Billing] paypal captureOrder failed:", err.message, err.detail || "");
    return res.status(502).json({ error: "paypal_capture_failed", detail: err.message });
  }

  // PayPal sometimes returns 200 with status=COMPLETED but no capture id
  // when the order has already been captured (e.g. webhook beat us). In
  // that case it's safe to no-op: the webhook handler will / has done
  // the bookkeeping.
  if (capture.status !== "COMPLETED") {
    return res.status(200).json({
      mode:        capture.mode,
      order_id:    capture.order_id,
      status:      capture.status,
      credited:    false,
      message:     "Order not in COMPLETED state; webhook will reconcile.",
    });
  }

  // Resolve which advertiser to credit. The order's custom_id is the
  // authoritative source (we set it at createOrder time). Fall back to
  // the body for demo mode where the PayPal response is synthetic.
  const customId = ((capture.raw && capture.raw.purchase_units) || []).map((pu) => pu.custom_id).find(Boolean);
  const advertiserId = customId || expectedAdvertiserId;
  if (!advertiserId) {
    console.error("[Billing] paypal capture missing custom_id and no advertiser_id provided");
    return res.status(400).json({ error: "cannot_resolve_advertiser" });
  }
  const amountUsd = capture.amount_usd || expectedAmount || 0;

  // Webhook-authoritative bookkeeping (Task #147, fixed 2026-06-18).
  //
  // We deliberately do NOT credit the advertiser balance here in
  // production. PayPal's PAYMENT.CAPTURE.COMPLETED webhook is the single
  // source of truth: durable (PayPal retries on delivery failure),
  // idempotent (event.id de-dup at line 2400-2407), and matches how the
  // Stripe path works. The return-URL hop you're handling here is
  // fragile (browser refresh, network blip, tab close); duplicating the
  // credit logic between this path and the webhook caused a double-credit
  // bug where every advertiser deposit was credited twice.
  //
  // Demo mode (in-memory ledger, no Supabase) still credits here so the
  // local development flow stays usable without webhook delivery.
  let credited = false;
  if (!HAS_SUPABASE) {
    credited = await creditAdvertiserForPayinEvent({
      provider:           "paypal",
      advertiserId,
      amountUsd,
      externalEventId:    capture.capture_id || capture.order_id,
      paypalOrderId:      capture.order_id,
      paypalCaptureId:    capture.capture_id,
      payerEmail:         capture.payer_email,
      description:        "PayPal deposit",
    });
  }

  return res.json({
    mode:        capture.mode,
    order_id:    capture.order_id,
    capture_id:  capture.capture_id,
    status:      capture.status,
    amount_usd:  amountUsd,
    advertiser_id: advertiserId,
    credited,
    // In production (HAS_SUPABASE), credited=false means "PayPal captured
    // the funds, webhook is about to credit the balance." The frontend
    // should briefly poll /api/billing?action=balance after a successful
    // capture; the webhook normally lands within 1-2s.
    webhook_authoritative: HAS_SUPABASE,
  });
}

async function handlePaypalOrderStatus(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const orderId = req.query && req.query.order_id;
  if (!orderId) return res.status(400).json({ error: "Missing order_id" });
  try {
    const order = await paypal.getOrder(orderId);
    return res.json(order);
  } catch (err) {
    return res.status(502).json({ error: "paypal_status_failed", detail: err.message });
  }
}

async function handlePaypalRefund(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  // Admin-only refund — same Authorization pattern the admin payouts
  // routes use. ADMIN_TOKEN is separate from CRON_SECRET so a leaked
  // cron token can't trigger refunds.
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken) {
    const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
    if (!auth || auth !== `Bearer ${adminToken}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }
  const { capture_id, amount, note } = req.body || {};
  if (!capture_id) return res.status(400).json({ error: "Missing capture_id" });

  try {
    const refund = await paypal.refundCapture(capture_id, {
      amountUsd: amount == null ? undefined : Number(amount),
      note,
      requestId: `bb_refund_${capture_id}_${Math.floor(Date.now() / 60000)}`,
    });
    // We deliberately do NOT debit the advertiser balance here; the
    // PAYMENT.CAPTURE.REFUNDED webhook is the authoritative debit
    // signal (matches how Stripe refunds are handled).
    return res.json(refund);
  } catch (err) {
    return res.status(502).json({ error: "paypal_refund_failed", detail: err.message });
  }
}

// ── Shared advertiser credit path (provider-agnostic) ─────────────────
// Both the Stripe checkout webhook and the PayPal capture flow funnel
// here so the bookkeeping is identical no matter which rail brought the
// money in. Returns true if the balance was actually credited (vs. a
// duplicate that was deduped).
async function creditAdvertiserForPayinEvent({
  provider, advertiserId, amountUsd,
  externalEventId, paypalOrderId, paypalCaptureId,
  payerEmail, description,
}) {
  if (!advertiserId || !Number.isFinite(Number(amountUsd)) || Number(amountUsd) <= 0) return false;
  const amount = Number(amountUsd);

  const sb = supa();
  if (sb) {
    // Idempotency: look for an existing transaction with the same
    // external event id (capture_id for PayPal, session.id for Stripe)
    // before crediting.
    if (externalEventId) {
      try {
        const { data: existing } = await sb.from("transactions")
          .select("id, status")
          .or(`paypal_capture_id.eq.${externalEventId},stripe_session_id.eq.${externalEventId}`)
          .limit(1);
        if (existing && existing.length > 0 && existing[0].status === "completed") {
          return false;
        }
      } catch (_) { /* transactions schema may not have these columns yet */ }
    }

    // Atomic balance increment via the shared RPC, with fallback for
    // older deploys that don't have it.
    const { error: rpcErr } = await sb.rpc("bbx_credit_advertiser_balance", {
      p_advertiser_id: advertiserId,
      p_amount_usd:    amount,
    });
    if (rpcErr && rpcErr.message && rpcErr.message.includes("does not exist")) {
      try {
        const { data: adv } = await sb.from("advertisers").select("balance").eq("id", advertiserId).single();
        if (adv) {
          await sb.from("advertisers")
            .update({ balance: (parseFloat(adv.balance) || 0) + amount })
            .eq("id", advertiserId);
        }
      } catch (e) {
        console.error("[Billing] advertiser balance fallback failed:", e.message);
      }
    } else if (rpcErr) {
      console.error("[Billing] advertiser RPC credit failed:", rpcErr.message);
    }

    try {
      const row = {
        advertiser_id: advertiserId,
        type:          "deposit",
        amount,
        description:   description || `${provider} deposit`,
        provider,
        status:        "completed",
      };
      if (paypalOrderId)   row.paypal_order_id   = paypalOrderId;
      if (paypalCaptureId) row.paypal_capture_id = paypalCaptureId;
      if (payerEmail)      row.payer_email       = payerEmail;

      // Try to update the pending row that createPaypalOrder stamped at
      // order-create time. The pending row has paypal_order_id set but
      // paypal_capture_id=NULL — so an onConflict upsert on
      // paypal_capture_id never matches it, which would leave an orphan
      // "pending" row behind and (combined with the pre-fix capture-
      // handler credit) cause the original double-credit bug.
      let updated = false;
      if (paypalOrderId) {
        try {
          const { data: updatedRows } = await sb.from("transactions")
            .update({
              status:            "completed",
              description:       row.description,
              paypal_capture_id: paypalCaptureId || null,
              ...(payerEmail ? { payer_email: payerEmail } : {}),
            })
            .eq("paypal_order_id", paypalOrderId)
            .eq("status",          "pending")
            .select("id");
          updated = !!(updatedRows && updatedRows.length > 0);
        } catch (_) { /* column may not exist on older schemas */ }
      }

      if (!updated) {
        // No pending row to update (e.g. webhook arrived before the
        // pending stamp landed, or the row was stamped without
        // paypal_order_id). Fall back to upsert.
        await sb.from("transactions").upsert(row, { onConflict: "paypal_capture_id" });
      }
    } catch (_) { /* if schema lacks columns the row is best-effort */ }

    // Phase 4: send the branded "Deposit successful" email. Best-effort,
    // fire-and-forget — never block crediting on email. Failures are logged
    // by the emails module but don't propagate. We fetch the post-credit
    // balance + advertiser email here so the email shows the user what
    // their new spendable amount is.
    try {
      const { data: adv } = await sb.from("advertisers")
        .select("email, balance, company_name")
        .eq("id", advertiserId)
        .maybeSingle();
      if (adv && adv.email) {
        const { sendDepositSuccess } = require("./_lib/emails/send");
        // Don't await — we want the HTTP response to return immediately
        // and the email to send in the background.
        sendDepositSuccess({
          to:              adv.email,
          amountUsd:       amount,
          balanceAfterUsd: Number(adv.balance) || amount,
          companyName:     adv.company_name || null,
        }).catch((e) => console.error("[Billing] sendDepositSuccess threw:", e.message));
      }
    } catch (e) {
      console.warn("[Billing] could not send deposit-success email:", e.message);
    }

    return true;
  }

  // Demo mode: idempotency via the same processed-webhook set the
  // Stripe path uses, so retries don't double-credit.
  if (externalEventId && DEMO.processedWebhookIds.has(`payin:${externalEventId}`)) {
    return false;
  }
  if (externalEventId) DEMO.processedWebhookIds.add(`payin:${externalEventId}`);
  const a = ensureDemoAdvertiser(advertiserId, { email: payerEmail });
  a.balance = (Number(a.balance) || 0) + amount;
  DEMO.events.push({ at: new Date().toISOString(), type: `${provider}.deposit.captured`, advertiser_id: advertiserId, amount });
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// Operator admin auth. Admin actions require Authorization: Bearer
// ${ADMIN_TOKEN}. Demo mode skips auth so unit tests can exercise the
// state machine without an env var.
// ═══════════════════════════════════════════════════════════════════════

function isAdminAuthorized(req) {
  if (!HAS_SUPABASE) return true;
  // Accept either env name so the admin console only needs one secret
  // configured (ADMIN_TOKEN and BBX_ADMIN_KEY are treated as equivalent
  // across api/stats, api/billing and api/campaigns).
  const keys = [process.env.ADMIN_TOKEN, process.env.BBX_ADMIN_KEY].filter(Boolean);
  if (keys.length === 0) return false;
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  return keys.some((k) => auth === `Bearer ${k}`);
}

// ═══════════════════════════════════════════════════════════════════════
// Phase E Day 5 — E2E inventory diagnostic.
//
// Returns the count and most-recent timestamp at every checkpoint of the
// ad-serving funnel. Used by the Day 5 runbook to quickly verify
// each stage of the demo flow worked. One round-trip per call; no Stripe
// API hits.
//
// Auth: Authorization: Bearer ${ADMIN_TOKEN}
// ═══════════════════════════════════════════════════════════════════════
async function handleE2EInventory(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!isAdminAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });

  const sb = supa();
  if (!sb) {
    return res.json({
      mode: "demo",
      message: "E2E inventory only meaningful in Supabase production mode.",
    });
  }

  const out = {
    mode: "stripe",
    generated_at: new Date().toISOString(),
    advertisers:           { count: 0, latest_signup_at: null },
    advertiser_deposits:   { total_usd: 0, count: 0, latest_at: null },
    campaigns_active:      { count: 0, latest_launched_at: null },
    auctions_24h:          { total: 0, sandbox: 0, production: 0 },
    impressions_24h:       { production: 0, sandbox: 0 },
    paying_events_1h:      { count: 0, total_publisher_payout_usd: 0 },
    developers:            { count: 0 },
    publisher_balances:    { with_positive_balance: 0, total_owed_to_publishers_usd: 0 },
  };

  try {
    // Advertisers
    const { count: advCount } = await sb.from("advertisers")
      .select("*", { count: "exact", head: true });
    out.advertisers.count = advCount || 0;
    const { data: lastAdv } = await sb.from("advertisers")
      .select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (lastAdv) out.advertisers.latest_signup_at = lastAdv.created_at;

    // Advertiser deposits (transactions of type='deposit', completed)
    try {
      const { data: deposits } = await sb.from("transactions")
        .select("amount, created_at").eq("type", "deposit").eq("status", "completed");
      if (Array.isArray(deposits)) {
        out.advertiser_deposits.count = deposits.length;
        out.advertiser_deposits.total_usd = +deposits.reduce(
          (s, d) => s + (parseFloat(d.amount) || 0), 0,
        ).toFixed(2);
        const latest = deposits.reduce((a, b) =>
          new Date(b.created_at) > new Date(a.created_at) ? b : a, deposits[0]);
        if (latest) out.advertiser_deposits.latest_at = latest.created_at;
      }
    } catch (_) { /* transactions table may not exist; skip */ }

    // Active campaigns
    const { count: campCount } = await sb.from("campaigns")
      .select("*", { count: "exact", head: true }).eq("status", "active");
    out.campaigns_active.count = campCount || 0;
    const { data: lastCamp } = await sb.from("campaigns")
      .select("created_at").eq("status", "active")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (lastCamp) out.campaigns_active.latest_launched_at = lastCamp.created_at;

    // 24h auctions
    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count: prodAucs } = await sb.from("auction_logs")
      .select("*", { count: "exact", head: true })
      .eq("is_sandbox", false).eq("outcome", "won").gte("ts", since24h);
    const { count: sbxAucs } = await sb.from("auction_logs")
      .select("*", { count: "exact", head: true })
      .eq("is_sandbox", true).eq("outcome", "sandbox").gte("ts", since24h);
    out.auctions_24h.production = prodAucs || 0;
    out.auctions_24h.sandbox = sbxAucs || 0;
    out.auctions_24h.total = out.auctions_24h.production + out.auctions_24h.sandbox;

    // 24h impressions
    const { count: prodImps } = await sb.from("events")
      .select("*", { count: "exact", head: true })
      .eq("event_type", "impression").eq("is_sandbox", false).gte("created_at", since24h);
    const { count: sbxImps } = await sb.from("events")
      .select("*", { count: "exact", head: true })
      .eq("event_type", "impression").eq("is_sandbox", true).gte("created_at", since24h);
    out.impressions_24h.production = prodImps || 0;
    out.impressions_24h.sandbox = sbxImps || 0;

    // 1h paying events (developer_payout > 0)
    const since1h = new Date(Date.now() - 3600 * 1000).toISOString();
    const { data: payingEvts } = await sb.from("events")
      .select("developer_payout")
      .gt("developer_payout", 0).eq("is_sandbox", false).gte("created_at", since1h);
    if (Array.isArray(payingEvts)) {
      out.paying_events_1h.count = payingEvts.length;
      out.paying_events_1h.total_publisher_payout_usd = +payingEvts.reduce(
        (s, e) => s + (parseFloat(e.developer_payout) || 0), 0,
      ).toFixed(4);
    }

    // Developers
    const { count: devCount } = await sb.from("developers")
      .select("*", { count: "exact", head: true });
    out.developers.count = devCount || 0;

    // Publisher balances
    const { data: bals } = await sb.from("publisher_balance")
      .select("balance").gt("balance", 0);
    if (Array.isArray(bals)) {
      out.publisher_balances.with_positive_balance = bals.length;
      out.publisher_balances.total_owed_to_publishers_usd = +bals.reduce(
        (s, b) => s + (parseFloat(b.balance) || 0), 0,
      ).toFixed(2);
    }

  } catch (e) {
    console.error("bbx:e2e_inventory:fail", JSON.stringify({ message: e && e.message }));
    out.error = e && e.message;
  }

  return res.json(out);
}

// GET /api/billing?action=integration_verify&developer_id=<UUID>
//
// Phase F — onboarding wizard verification. Returns per-door integration
// state for a given publisher:
//
//   {
//     mcp:        { active, impressions_24h, clicks_24h, last_seen_at },
//     js-snippet: { ... },
//     npm-sdk:    { ... },
//     rest-api:   { ... },
//     any_active: boolean,
//     first_door_at: ISO timestamp or null  (first time any door went active)
//   }
//
// Used by the dashboard's per-door wizard to render real-time "✓ Verified"
// checkmarks. Public — no auth — because the data is per-publisher and
// the developer_id is the identifier the publisher already knows about
// themselves.
async function handleIntegrationVerify(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const developerId = req.query && (req.query.developer_id || req.query.id);
  if (!developerId) return res.status(400).json({ error: "Missing developer_id" });

  const DOORS = ["mcp", "js-snippet", "npm-sdk", "rest-api"];

  // Demo mode
  const sb = supa();
  if (!sb) {
    const out = { mode: "demo", any_active: false, first_door_at: null };
    for (const d of DOORS) {
      out[d] = { active: false, impressions_24h: 0, clicks_24h: 0, last_seen_at: null };
    }
    return res.json(out);
  }

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // One query, group in JS — Supabase JS client doesn't expose GROUP BY
  // cleanly without raw SQL.
  // 2026-05-20 — also select session_id so we can distinguish synthetic
  // dashboard tests (session_id starts with "test_") from real production
  // traffic. Live impressions are the meaningful signal that the
  // publisher's code is actually serving ads in their app.
  let rows = [];
  try {
    const { data, error } = await sb.from("events")
      .select("event_type, integration_method, created_at, session_id")
      .eq("developer_id", developerId)
      .gte("created_at", since)
      .not("integration_method", "is", null);
    if (error) throw error;
    rows = data || [];
  } catch (e) {
    console.error("bbx:integration_verify:fail",
      JSON.stringify({ developer_id: developerId, message: e && e.message }));
    return res.status(500).json({ error: "query failed", message: e && e.message });
  }

  // Helper — synthetic events come from the publisher dashboard's Run Test
  // button, which sets session_id="test_<timestamp>". Real production
  // events from installed SDKs use UUID-shaped or random session ids.
  function isSyntheticSession(sid) {
    return typeof sid === "string" && sid.startsWith("test_");
  }

  const byDoor = {};
  for (const d of DOORS) byDoor[d] = {
    impressions_24h: 0, clicks_24h: 0, last_seen_at: null,
    // 2026-05-20 — distinguish synthetic test events from real ones so the
    // badge can show "Verified (test only)" vs "Live · production".
    live_impressions_24h: 0, live_clicks_24h: 0, last_live_at: null,
    synthetic_impressions_24h: 0, synthetic_clicks_24h: 0, last_synthetic_at: null,
  };
  for (const r of rows) {
    const door = r.integration_method;
    if (!byDoor[door]) continue;
    const synthetic = isSyntheticSession(r.session_id);
    if (r.event_type === "impression") {
      byDoor[door].impressions_24h++;
      if (synthetic) byDoor[door].synthetic_impressions_24h++;
      else           byDoor[door].live_impressions_24h++;
    }
    if (r.event_type === "click") {
      byDoor[door].clicks_24h++;
      if (synthetic) byDoor[door].synthetic_clicks_24h++;
      else           byDoor[door].live_clicks_24h++;
    }
    if (!byDoor[door].last_seen_at || new Date(r.created_at) > new Date(byDoor[door].last_seen_at)) {
      byDoor[door].last_seen_at = r.created_at;
    }
    if (synthetic) {
      if (!byDoor[door].last_synthetic_at || new Date(r.created_at) > new Date(byDoor[door].last_synthetic_at)) {
        byDoor[door].last_synthetic_at = r.created_at;
      }
    } else {
      if (!byDoor[door].last_live_at || new Date(r.created_at) > new Date(byDoor[door].last_live_at)) {
        byDoor[door].last_live_at = r.created_at;
      }
    }
  }

  const out = { mode: "stripe", any_active: false, any_live: false, first_door_at: null };
  for (const d of DOORS) {
    const v = byDoor[d];
    const active = (v.impressions_24h + v.clicks_24h) > 0;
    // "Live" status = any non-synthetic event seen. This is the bit that
    // tells the publisher their actual installed code is firing — not
    // just dashboard test clicks. The UI uses this to differentiate
    // "Verified (test only)" from "Live".
    const live = (v.live_impressions_24h + v.live_clicks_24h) > 0;
    out[d] = { active, live, ...v };
    if (active) out.any_active = true;
    if (live)   out.any_live   = true;
    if (active && v.last_seen_at) {
      if (!out.first_door_at || new Date(v.last_seen_at) < new Date(out.first_door_at)) {
        out.first_door_at = v.last_seen_at;
      }
    }
  }
  return res.json(out);
}

// ── invoice generation (advertiser) ────────────────────────────────────
// Reads the auction ledger for all wins on this advertiser's campaigns
// in the period and sums them. Optionally creates a Stripe invoice.
async function handleInvoice(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { advertiser_id, since, until, campaign_ids, finalize = false } = req.body || {};
  if (!advertiser_id) return res.status(400).json({ error: "Missing advertiser_id" });

  // Pull win amounts from the ledger
  const dump = ledger._dump();
  const cidSet = Array.isArray(campaign_ids) ? new Set(campaign_ids) : null;
  const sinceTs = since ? new Date(since).getTime() : Date.now() - 30 * 86400 * 1000;
  const untilTs = until ? new Date(until).getTime() : Date.now();

  // In-memory ledger keys campaigns by campaign_id; if Supabase, query directly
  let wins = [];
  const sb = supa();
  if (sb) {
    let q = sb.from("rtb_bids")
      .select("id, campaign_id, won_price_cpm, won_at")
      .eq("status", "won")
      .gte("won_at", new Date(sinceTs).toISOString())
      .lte("won_at", new Date(untilTs).toISOString());
    if (cidSet) q = q.in("campaign_id", [...cidSet]);
    const { data } = await q;
    wins = data || [];
  } else {
    wins = dump.bids.filter((b) => b.status === "won"
      && (!cidSet || cidSet.has(b.campaign_id))
      && new Date(b.won_at).getTime() >= sinceTs
      && new Date(b.won_at).getTime() <= untilTs);
  }

  const grossUsd = wins.reduce((sum, b) => sum + (Number(b.won_price_cpm) || 0) / 1000, 0);
  const lineItems = aggregateByCampaign(wins);

  const invoice = {
    id: "inv_" + Math.random().toString(36).slice(2, 12),
    advertiser_id,
    period: { since: new Date(sinceTs).toISOString(), until: new Date(untilTs).toISOString() },
    impressions: wins.length,
    line_items: lineItems,
    subtotal_usd: +grossUsd.toFixed(4),
    // Fee disclosure for the advertiser invoice. The 6.5% RTB exchange fee
    // is a demand-side fee that shows up here; the 23.5% network take is
    // deducted from publisher share, not from the advertiser, so it does
    // not appear on the advertiser-facing invoice.
    rtb_fee_rate: RTB_FEE,
    rtb_fee_usd:  +(grossUsd * RTB_FEE).toFixed(4),
    take_rate:    TAKE_RATE, // combined fees (legacy field, kept for back-compat)
    total_usd:    +grossUsd.toFixed(4), // advertiser pays gross; take is deducted from publisher share
    currency: "USD",
    status: "draft",
    created_at: new Date().toISOString(),
  };

  // Optionally finalize via Stripe
  const s = stripe();
  if (finalize && s) {
    const cents = Math.round(invoice.total_usd * 100);
    if (cents > 0) {
      // For Stripe Invoicing we'd need a Customer; for v1 use a one-shot PaymentIntent
      const pi = await s.paymentIntents.create({
        amount: cents, currency: "usd",
        description: `BBX usage ${invoice.period.since.slice(0,10)} – ${invoice.period.until.slice(0,10)}`,
        metadata: { invoice_id: invoice.id, advertiser_id },
      });
      invoice.stripe_payment_intent = pi.id;
      invoice.client_secret         = pi.client_secret;
      invoice.status                = "finalized";
    }
  } else if (finalize) {
    // Demo: mark as finalized, deduct from in-memory balance
    const a = ensureDemoAdvertiser(advertiser_id);
    a.balance = Math.max(0, a.balance - invoice.total_usd);
    invoice.status = "finalized_demo";
  }

  DEMO.invoices.set(invoice.id, invoice);
  return res.json({ mode: HAS_STRIPE ? "stripe" : "demo", invoice });
}

function aggregateByCampaign(wins) {
  const m = new Map();
  for (const w of wins) {
    const cur = m.get(w.campaign_id) || { campaign_id: w.campaign_id, impressions: 0, gross_usd: 0 };
    cur.impressions += 1;
    cur.gross_usd   += (Number(w.won_price_cpm) || 0) / 1000;
    m.set(w.campaign_id, cur);
  }
  return [...m.values()].map((r) => ({
    campaign_id: r.campaign_id,
    impressions: r.impressions,
    gross_usd:   +r.gross_usd.toFixed(4),
    avg_cpm:     +(r.impressions ? (r.gross_usd / r.impressions) * 1000 : 0).toFixed(4),
  }));
}

// ── Stripe webhook (signature-verified) ────────────────────────────────
async function handleWebhook(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const s = stripe();
  let event;
  if (s && STRIPE_WEBHOOK_KEY) {
    // Stripe sends the raw body; Vercel provides it via req.rawBody when configured.
    const sig = req.headers["stripe-signature"];
    const raw = req.rawBody || (typeof req.body === "string" ? req.body : JSON.stringify(req.body));
    try {
      event = s.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_KEY);
    } catch (err) {
      console.error("[Billing] webhook signature verification failed:", err.message);
      return res.status(400).json({ error: "Invalid signature" });
    }
  } else if (HAS_SUPABASE) {
    // Production mode but webhook secret is missing — reject to prevent unsigned events
    console.error("[Billing] STRIPE_WEBHOOK_SECRET is not set but Supabase is configured. Rejecting unsigned webhook.");
    return res.status(500).json({ error: "Webhook secret not configured — cannot verify Stripe signature in production" });
  } else {
    // Demo mode — accept the event without verification but tag it as untrusted
    event = req.body;
    if (!event || !event.type) return res.status(400).json({ error: "Missing event payload" });
    event.untrusted = true;
  }

  // Idempotency: skip already-processed events (Stripe may retry)
  const eventId = event.id || `demo_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  if (DEMO.processedWebhookIds.has(eventId)) {
    return res.json({ received: true, event_type: event.type, duplicate: true });
  }
  // In production, check the DB for duplicate event IDs
  const sb = supa();
  if (sb && event.id) {
    try {
      const { data: existing } = await sb.from("transactions")
        .select("id").eq("stripe_session_id", event.id).limit(1);
      if (existing && existing.length > 0) {
        return res.json({ received: true, event_type: event.type, duplicate: true });
      }
    } catch (_) { /* transactions table may not exist yet — continue */ }
  }
  DEMO.processedWebhookIds.add(eventId);

  DEMO.events.push({ at: new Date().toISOString(), type: event.type, event_id: eventId, untrusted: !!event.untrusted });

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const advertiserId = session.metadata && session.metadata.advertiser_id;
    const amount       = parseFloat((session.metadata && session.metadata.amount) || 0);
    if (advertiserId && Number.isFinite(amount) && amount > 0) {
      const sb = supa();
      if (sb) {
        // Atomic increment using RPC to avoid read-then-write race
        const { error: rpcErr } = await sb.rpc("bbx_credit_advertiser_balance", {
          p_advertiser_id: advertiserId,
          p_amount_usd: amount,
        });
        // Fallback: if the RPC doesn't exist, do read-then-write
        if (rpcErr && rpcErr.message && rpcErr.message.includes("does not exist")) {
          try {
            const { data: adv, error: advErr } = await sb.from("advertisers").select("balance").eq("id", advertiserId).single();
            if (advErr) {
              console.error("[Billing] webhook balance fallback lookup failed:", advErr.message);
            } else if (adv) {
              await sb.from("advertisers")
                .update({ balance: (parseFloat(adv.balance) || 0) + amount })
                .eq("id", advertiserId);
            }
          } catch (fallbackErr) {
            console.error("[Billing] webhook balance fallback error:", fallbackErr.message);
          }
        } else if (rpcErr) {
          console.error("[Billing] webhook RPC credit failed:", rpcErr.message);
        }
        // Also record the transaction for history
        try {
          await sb.from("transactions").insert({
            advertiser_id: advertiserId, type: "deposit",
            amount, description: "Stripe deposit",
            stripe_session_id: session.id,
            status: "completed",
          });
        } catch (_) { /* transactions table may not exist yet */ }
      } else {
        const a = ensureDemoAdvertiser(advertiserId);
        a.balance += amount;
      }
    }
  }

  // Handle failed charges — record the failed deposit attempt for history
  if (event.type === "charge.failed") {
    const charge = event.data.object;
    console.warn("[Billing] charge.failed:", charge.id, charge.failure_message);
    if (sb && charge.metadata && charge.metadata.advertiser_id) {
      try {
        await sb.from("transactions").insert({
          advertiser_id: charge.metadata.advertiser_id, type: "deposit",
          amount: (charge.amount || 0) / 100, description: `Failed charge: ${charge.failure_message || "unknown"}`,
          stripe_session_id: charge.id, status: "failed",
        });
      } catch (_) {}
    }
  }

  // Handle refunds — deduct from advertiser balance AND fire publisher clawback (Phase E HARD-1).
  if (event.type === "charge.refunded") {
    const charge = event.data.object;
    const refundAmount = (charge.amount_refunded || 0) / 100;
    const advertiserId = charge.metadata && charge.metadata.advertiser_id;
    if (advertiserId && refundAmount > 0) {
      if (sb) {
        const { error: rpcErr } = await sb.rpc("bbx_credit_advertiser_balance", {
          p_advertiser_id: advertiserId, p_amount_usd: -refundAmount,
        });
        if (rpcErr) {
          try {
            const { data: adv } = await sb.from("advertisers").select("balance").eq("id", advertiserId).single();
            if (adv) {
              await sb.from("advertisers")
                .update({ balance: Math.max(0, (parseFloat(adv.balance) || 0) - refundAmount) })
                .eq("id", advertiserId);
            }
          } catch (_) {}
        }
        try {
          await sb.from("transactions").insert({
            advertiser_id: advertiserId, type: "refund",
            amount: -refundAmount, description: "Stripe refund",
            stripe_session_id: charge.id, status: "completed",
          });
        } catch (_) {}

        // ── Publisher clawback (Phase E HARD-1) ──
        // Find every campaign that was funded by this refunded charge, sum
        // each publisher's attributed share (85% of attributed spend), and
        // try to deduct from balance. Insufficient balance → row stays
        // pending and future earnings satisfy it first. Per Decision 7.
        try {
          await fireRefundClawbacks(sb, advertiserId, refundAmount, charge.id);
        } catch (e) {
          console.error("bbx:clawback:fail", JSON.stringify({
            tag: "clawback.fail", advertiser_id: advertiserId,
            refund_amount: refundAmount, charge_id: charge.id,
            message: e && e.message,
          }));
        }
      } else {
        const a = ensureDemoAdvertiser(advertiserId);
        a.balance = Math.max(0, a.balance - refundAmount);
      }
    }
  }

  return res.json({ received: true, event_type: event.type, mode: HAS_STRIPE ? "stripe" : "demo" });
}

// ════════════════════════════════════════════════════════════════════
// ── Phase 2 — PayPal webhook (signature-verified via PayPal API) ─────
// ════════════════════════════════════════════════════════════════════
//
// Unlike Stripe, PayPal doesn't sign with an HMAC we can verify
// locally. Instead we POST the headers + event back to PayPal's
// verify-webhook-signature endpoint and trust their reply.
//
// Events we care about:
//   PAYMENT.CAPTURE.COMPLETED — advertiser deposit landed
//   PAYMENT.CAPTURE.REFUNDED  — advertiser refund issued
//   PAYMENT.CAPTURE.DENIED    — capture rejected (rare; logs only)
//   PAYMENT.CAPTURE.PENDING   — review hold (logs only)
//
// The shim that delivers the raw body to this handler lives in
// api/paypal-webhook.js (mirrors how api/stripe-webhook.js wraps
// handleWebhook).
async function handlePaypalWebhook(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const raw = req.rawBody || (typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}));

  let verification;
  try {
    verification = await paypal.verifyWebhook({
      headers:   req.headers || {},
      rawBody:   raw,
      webhookId: process.env.PAYPAL_WEBHOOK_ID,
    });
  } catch (err) {
    console.error("[Billing] paypal verifyWebhook failed:", err.message);
    return res.status(502).json({ error: "paypal_verify_failed", detail: err.message });
  }

  if (!verification.verified && HAS_PAYPAL) {
    console.error("[Billing] paypal webhook verification did not succeed:", verification.status);
    return res.status(400).json({ error: "invalid_signature", status: verification.status });
  }

  let event;
  try { event = JSON.parse(raw); }
  catch (_) { return res.status(400).json({ error: "Invalid JSON body" }); }
  if (!event || !event.event_type) return res.status(400).json({ error: "Missing event payload" });

  // Idempotency: PayPal includes a stable `id` on every event.
  const eventId = event.id || `paypal_demo_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  if (DEMO.processedWebhookIds.has(eventId)) {
    return res.json({ received: true, event_type: event.event_type, duplicate: true });
  }
  const sb = supa();
  if (sb && event.id) {
    try {
      const { data: existing } = await sb.from("transactions")
        .select("id").eq("paypal_event_id", event.id).limit(1);
      if (existing && existing.length > 0) {
        return res.json({ received: true, event_type: event.event_type, duplicate: true });
      }
    } catch (_) { /* paypal_event_id column may not exist yet */ }
  }
  DEMO.processedWebhookIds.add(eventId);
  DEMO.events.push({
    at: new Date().toISOString(),
    type: event.event_type,
    event_id: eventId,
    untrusted: verification.mode === "demo",
  });

  const resource = (event.resource || {});

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    // Resolve advertiser id from custom_id (we stamped this at order create time)
    const advertiserId = resource.custom_id || (resource.supplementary_data && resource.supplementary_data.related_ids && resource.supplementary_data.related_ids.advertiser_id);
    const amount       = Number((resource.amount && resource.amount.value) || 0);
    const captureId    = resource.id;
    const orderId      = (resource.supplementary_data && resource.supplementary_data.related_ids && resource.supplementary_data.related_ids.order_id) || null;
    const payerEmail   = (resource.payer && resource.payer.email_address) || null;
    if (advertiserId && amount > 0) {
      await creditAdvertiserForPayinEvent({
        provider:        "paypal",
        advertiserId,
        amountUsd:       amount,
        externalEventId: captureId || eventId,
        paypalOrderId:   orderId,
        paypalCaptureId: captureId,
        payerEmail,
        description:     "PayPal deposit (webhook)",
      });
    } else {
      console.warn("[Billing] paypal capture.completed missing advertiser/amount", { advertiserId, amount, captureId });
    }
  }

  if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
    // Refunds: debit the advertiser balance and fire any publisher
    // clawbacks tied to that advertiser's campaigns (same call the
    // Stripe refund path uses).
    const refundedCaptureId = resource.id;  // resource is the refund itself
    const linkedCaptureId   = ((resource.links || []).find((l) => l.rel === "up") || {}).href || null;
    const refundAmount      = Number((resource.amount && resource.amount.value) || 0);
    const advertiserId      = resource.custom_id || null;

    if (sb && refundAmount > 0) {
      // Try to look the original capture up by its id to find the advertiser
      let resolvedAdvertiserId = advertiserId;
      try {
        if (!resolvedAdvertiserId && linkedCaptureId) {
          const m = linkedCaptureId.match(/captures\/([^/]+)/);
          const sourceCapture = m && m[1];
          if (sourceCapture) {
            const { data } = await sb.from("transactions")
              .select("advertiser_id").eq("paypal_capture_id", sourceCapture).limit(1);
            resolvedAdvertiserId = data && data[0] && data[0].advertiser_id;
          }
        }
        if (resolvedAdvertiserId) {
          // Debit balance — best effort. fireRefundClawbacks runs after.
          try {
            await sb.rpc("bbx_credit_advertiser_balance", {
              p_advertiser_id: resolvedAdvertiserId,
              p_amount_usd:    -refundAmount,
            });
          } catch (e) { console.error("[Billing] paypal refund balance debit failed:", e.message); }
          try { await fireRefundClawbacks(sb, resolvedAdvertiserId, refundAmount, refundedCaptureId); }
          catch (e) { console.error("[Billing] paypal refund clawbacks failed:", e.message); }

          try {
            await sb.from("transactions").insert({
              advertiser_id: resolvedAdvertiserId,
              type:          "refund",
              amount:        -refundAmount,
              description:   "PayPal refund",
              provider:      "paypal",
              status:        "completed",
              paypal_event_id:   eventId,
              paypal_capture_id: refundedCaptureId,
            });
          } catch (_) { /* schema gap is non-fatal */ }
        }
      } catch (e) {
        console.error("[Billing] paypal refund handling error:", e.message);
      }
    } else if (!sb) {
      // Demo mode — just decrement the in-memory advertiser balance
      if (advertiserId) {
        const a = DEMO.advertisers.get(advertiserId);
        if (a) a.balance = Math.max(0, (Number(a.balance) || 0) - refundAmount);
      }
    }
  }

  if (event.event_type === "PAYMENT.CAPTURE.DENIED" || event.event_type === "PAYMENT.CAPTURE.PENDING") {
    // Surfaceable for ops but no balance change. Mark transactions row.
    if (sb && resource.id) {
      try {
        await sb.from("transactions")
          .update({ status: event.event_type === "PAYMENT.CAPTURE.DENIED" ? "denied" : "pending_review" })
          .eq("paypal_capture_id", resource.id);
      } catch (_) { /* best effort */ }
    }
  }

  return res.json({
    received:    true,
    event_type:  event.event_type,
    verified:    verification.verified,
    mode:        verification.mode,
  });
}

/**
 * Phase E HARD-1 — fire publisher clawbacks when an advertiser charge is
 * refunded. Per Decision 7 of the design doc:
 *
 *   1. Find every (publisher, attributed_share) pair from events tied to
 *      this advertiser's campaigns.
 *   2. Pro-rate the refund across publishers in the same ratio.
 *   3. For each publisher: try to deduct from balance first; if balance
 *      insufficient, log a 'pending' clawback that future earnings satisfy.
 *
 * Day 1 implementation is intentionally conservative — it logs the
 * clawback intent to payout_clawbacks and (when balance is sufficient)
 * decrements the balance. The full "future earnings satisfy pending
 * clawback first" reconciliation lives in api/track.js (Day 2/3 wiring
 * once per-event accrual ships). Either way, no operator action required.
 */
async function fireRefundClawbacks(sb, advertiserId, refundAmount, sourceStripeId) {
  if (!sb || !advertiserId || refundAmount <= 0) return;

  // Step 1: sum publisher_payout per publisher for events on this
  // advertiser's campaigns. Cap the lookback at 90 days to bound the
  // query — refunds beyond that are exceedingly rare and unrecoverable
  // anyway (Decision 7's 90-day operator escalation).
  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const { data: camps, error: campErr } = await sb.from("campaigns")
    .select("id").eq("advertiser_id", advertiserId);
  if (campErr || !Array.isArray(camps) || camps.length === 0) {
    console.warn("bbx:clawback:no_campaigns",
      JSON.stringify({ advertiser_id: advertiserId, refund: refundAmount }));
    return;
  }
  const campaignIds = camps.map((c) => c.id);
  const { data: evts, error: evtErr } = await sb.from("events")
    .select("developer_id, developer_payout, cost, campaign_id")
    .in("campaign_id", campaignIds)
    .eq("is_sandbox", false)
    .gte("created_at", since)
    .gt("developer_payout", 0);
  if (evtErr) {
    console.error("bbx:clawback:events_query_fail", evtErr.message);
    return;
  }
  if (!Array.isArray(evts) || evts.length === 0) return;

  // Aggregate attributed earnings per publisher + total spend on these
  // campaigns. Pro-rate refund by each publisher's share of total spend.
  const totalSpend = evts.reduce((s, e) => s + (parseFloat(e.cost) || 0), 0);
  if (totalSpend <= 0) return;
  const perPub = new Map();
  for (const e of evts) {
    if (!e.developer_id) continue;
    const cur = perPub.get(e.developer_id) || { earned: 0, spend: 0, campaign_id: e.campaign_id };
    cur.earned += parseFloat(e.developer_payout) || 0;
    cur.spend  += parseFloat(e.cost) || 0;
    perPub.set(e.developer_id, cur);
  }

  // Iterate by developer_id (the project's existing FK convention for
  // publishers — see api/_lib/campaign_history.js, supabase-schema.sql).
  for (const [developerId, stats] of perPub) {
    const share = (stats.spend / totalSpend) * refundAmount;     // refund pro-rated by spend
    const clawAmount = Math.min(stats.earned, share * 0.85);     // clawback bounded by what they actually earned
    if (clawAmount <= 0) continue;

    // Read current balance to decide applied-vs-pending.
    let currentBalance = 0;
    try {
      const { data: bal } = await sb.from("publisher_balance")
        .select("balance").eq("developer_id", developerId).maybeSingle();
      currentBalance = parseFloat(bal && bal.balance) || 0;
    } catch (_) {}

    const canCover = currentBalance >= clawAmount;
    const status   = canCover ? "applied" : "pending";

    try {
      await sb.from("payout_clawbacks").insert({
        developer_id:       developerId,
        amount_usd:         clawAmount,
        remaining_usd:      canCover ? 0 : clawAmount,
        source_event_type:  "refund",
        source_stripe_id:   sourceStripeId,
        source_campaign_id: stats.campaign_id,
        status,
        applied_at:         canCover ? new Date().toISOString() : null,
        notes:              "auto-clawback from charge.refunded webhook",
      });

      if (canCover) {
        // Atomic decrement attempt; fall back to read-modify-write.
        try {
          await sb.rpc("bbx_decrement_publisher_balance", {
            p_developer_id: developerId,
            p_amount_usd:   clawAmount,
          });
        } catch (_) {
          const newBalance = Math.max(0, currentBalance - clawAmount);
          await sb.from("publisher_balance").update({
            balance:    newBalance,
            updated_at: new Date().toISOString(),
          }).eq("developer_id", developerId);
        }
      }
    } catch (e) {
      // Table may not exist pre-migration 12 — log but don't bubble up.
      console.error("bbx:clawback:insert_fail",
        JSON.stringify({ developer_id: developerId, amount: clawAmount, message: e && e.message }));
    }
  }
}
module.exports._fireRefundClawbacks = fireRefundClawbacks;

// ── exports for testing ────────────────────────────────────────────────
module.exports.HAS_STRIPE    = HAS_STRIPE;
module.exports.HAS_SUPABASE  = HAS_SUPABASE;
module.exports.RTB_FEE       = RTB_FEE;
module.exports.NETWORK_TAKE  = NETWORK_TAKE;
module.exports.TAKE_RATE     = TAKE_RATE; // legacy aggregate, kept for back-compat
module.exports._DEMO         = DEMO;
module.exports._reset = function () {
  DEMO.advertisers.clear();
  DEMO.developers.clear();
  DEMO.invoices.clear();
  DEMO.events.length = 0;
  DEMO.processedWebhookIds.clear();
};
