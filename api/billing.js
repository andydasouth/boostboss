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
 *   POST /api/billing?action=create_connect     publisher onboards Connect
 *   POST /api/billing?action=invoice            generate an invoice from the
 *                                                ledger for an advertiser
 *                                                (sum of won_price_cpm / 1000
 *                                                over the period)
 *   POST /api/billing?action=payout             trigger Connect transfers to
 *                                                publishers based on impression
 *                                                revenue from the ledger
 *   POST /api/billing?action=webhook            Stripe webhook handler
 *                                                (signature-verified)
 *   GET  /api/billing?action=balance&id=...     advertiser balance
 *   GET  /api/billing?action=history&id=...     advertiser tx history
 *   GET  /api/billing?action=earnings&key=...   developer earnings
 *
 * Money model
 *   • Exchange take-rate: 15% (configurable via BBX_TAKE_RATE)
 *   • Publisher share:     85%
 *   • Min payout threshold: $100 (configurable via BBX_MIN_PAYOUT)
 *   • Currency: USD only for v1
 */

const ledger = require("./_lib/ledger.js");

const HAS_STRIPE   = !!process.env.STRIPE_SECRET_KEY;
const HAS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
);

const TAKE_RATE          = Number(process.env.BBX_TAKE_RATE)  || 0.15;
const MIN_PAYOUT_USD     = Number(process.env.BBX_MIN_PAYOUT) || 100.0;
const PUBLIC_BASE_URL    = process.env.BOOSTBOSS_BASE_URL     || "https://boostboss.ai";
const STRIPE_WEBHOOK_KEY = process.env.STRIPE_WEBHOOK_SECRET   || null;

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

// ── In-process demo accounts (reset on cold start) ─────────────────────
const DEMO = {
  advertisers: new Map(), // id → { id, email, balance, company_name }
  developers:  new Map(), // id → { id, email, total_earnings, app_name, stripe_account_id }
  invoices:    new Map(), // id → invoice record
  payouts:     new Map(), // id → payout record
  events:      [],        // append-only event log (mirrors webhook events)
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Stripe-Signature");
  res.setHeader("x-billing-mode", HAS_STRIPE ? "stripe" : "demo");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = (req.query && req.query.action) || (req.body && req.body.action);

  try {
    switch (action) {
      case "balance":         return await handleBalance(req, res);
      case "earnings":        return await handleEarnings(req, res);
      case "create_checkout": return await handleCreateCheckout(req, res);
      case "create_connect":  return await handleCreateConnect(req, res);
      case "invoice":         return await handleInvoice(req, res);
      case "payout":          return await handlePayout(req, res);
      case "history":         return await handleHistory(req, res);
      case "webhook":         return await handleWebhook(req, res);
      default:                return res.status(400).json({ error: "Unknown action" });
    }
  } catch (err) {
    console.error("[Billing Error]", err);
    return res.status(500).json({ error: err.message });
  }
};

// ── balance ────────────────────────────────────────────────────────────
async function handleBalance(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Missing advertiser id" });

  const sb = supa();
  if (sb) {
    const { data, error } = await sb.from("advertisers")
      .select("balance, company_name").eq("id", id).single();
    if (error) return res.status(404).json({ error: "Advertiser not found" });
    return res.json({ balance: Number(data.balance), company_name: data.company_name });
  }
  const a = ensureDemoAdvertiser(id);
  return res.json({ balance: a.balance, company_name: a.company_name });
}

// ── history ───────────────────────────────────────────────────────────
async function handleHistory(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Missing advertiser id" });

  const sb = supa();
  if (sb) {
    // Attempt to read from a transactions table if it exists
    try {
      const { data, error } = await sb.from("transactions")
        .select("*").eq("advertiser_id", id).order("created_at", { ascending: false }).limit(50);
      if (!error && data) return res.json({ transactions: data });
    } catch (_) { /* table may not exist — fall through to demo */ }
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
    const pendingTotal = (pending || []).reduce((s, e) => s + parseFloat(e.developer_payout || 0), 0);
    return res.json({
      app_name: dev.app_name, total_earnings: dev.total_earnings,
      pending_payout: pendingTotal.toFixed(2),
      revenue_share_pct: dev.revenue_share_pct,
      payout_threshold: MIN_PAYOUT_USD, next_payout_date: nextPayoutDate(),
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
    payout_threshold: MIN_PAYOUT_USD, next_payout_date: nextPayoutDate(),
  });
}

// ── advertiser deposit (Stripe Checkout) ───────────────────────────────
async function handleCreateCheckout(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { advertiser_id, amount, email } = req.body || {};
  if (!advertiser_id || !amount) return res.status(400).json({ error: "Missing advertiser_id or amount" });
  if (Number(amount) < 10) return res.status(400).json({ error: "Minimum deposit is $10" });

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

// ── publisher Stripe Connect onboarding ────────────────────────────────
async function handleCreateConnect(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { developer_id, email } = req.body || {};
  if (!developer_id) return res.status(400).json({ error: "Missing developer_id" });

  const s = stripe();
  if (!s) {
    const d = ensureDemoDeveloper(developer_id, { email });
    d.stripe_account_id = "acct_demo_" + developer_id.slice(-6);
    return res.json({
      mode: "demo", onboarding_url: null,
      message: "Demo mode — no real Stripe account created.",
      stripe_account_id: d.stripe_account_id,
    });
  }

  const account = await s.accounts.create({
    type: "express", email,
    capabilities: { transfers: { requested: true } },
    metadata: { developer_id },
  });
  const link = await s.accountLinks.create({
    account: account.id,
    refresh_url: `${PUBLIC_BASE_URL}/developer?stripe=refresh`,
    return_url:  `${PUBLIC_BASE_URL}/developer?stripe=connected`,
    type: "account_onboarding",
  });
  // Persist the account id
  const sb = supa();
  if (sb) await sb.from("developers").update({ stripe_account_id: account.id }).eq("id", developer_id);
  return res.json({ mode: "stripe", onboarding_url: link.url, stripe_account_id: account.id });
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
    take_rate: TAKE_RATE,
    total_usd:  +grossUsd.toFixed(4), // advertiser pays gross; take is deducted from publisher share
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

// ── publisher payout (Connect transfer) ────────────────────────────────
// Reads ledger wins keyed by site_domain / app_bundle, computes publisher
// share (1 - take_rate), and emits Stripe transfers (or simulates them in demo).
async function handlePayout(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { since, until, dry_run = true } = req.body || {};

  const sinceTs = since ? new Date(since).getTime() : Date.now() - 30 * 86400 * 1000;
  const untilTs = until ? new Date(until).getTime() : Date.now();
  const dump = ledger._dump();

  // Build {publisher_key → totals}. Publisher key = auction.site_domain || auction.app_bundle
  const aucById = new Map(dump.auctions.map((a) => [a.id, a]));
  const totals = new Map();
  for (const b of dump.bids) {
    if (b.status !== "won") continue;
    const wonAt = new Date(b.won_at).getTime();
    if (wonAt < sinceTs || wonAt > untilTs) continue;
    const auc = aucById.get(b.auction_id);
    const pub = (auc && (auc.site_domain || auc.app_bundle)) || "unknown_publisher";
    const cur = totals.get(pub) || { publisher: pub, impressions: 0, gross_usd: 0 };
    cur.impressions += 1;
    cur.gross_usd   += (Number(b.won_price_cpm) || 0) / 1000;
    totals.set(pub, cur);
  }

  const transfers = [];
  for (const t of totals.values()) {
    const pubShareUsd = +(t.gross_usd * (1 - TAKE_RATE)).toFixed(4);
    const eligible    = pubShareUsd >= MIN_PAYOUT_USD;
    transfers.push({
      publisher: t.publisher,
      impressions: t.impressions,
      gross_usd:   +t.gross_usd.toFixed(4),
      take_usd:    +(t.gross_usd * TAKE_RATE).toFixed(4),
      payout_usd:  pubShareUsd,
      eligible,
      reason:      eligible ? null : `below $${MIN_PAYOUT_USD} threshold`,
    });
  }

  // Execute transfers via Stripe Connect (only when not a dry run AND Stripe is live)
  const s = stripe();
  if (!dry_run && s) {
    const sb = supa();
    for (const t of transfers) {
      if (!t.eligible) continue;
      // Map publisher → stripe_account_id via publisher_domain in the developers table
      let acct = null;
      if (sb) {
        // publisher_domain matches site.domain from auction records (e.g. "cursor.com")
        const { data } = await sb.from("developers")
          .select("stripe_account_id").eq("publisher_domain", t.publisher).single();
        acct = data && data.stripe_account_id;
      }
      if (!acct) { t.transfer_skipped = "no Stripe Connect account on file"; continue; }
      const tr = await s.transfers.create({
        amount: Math.round(t.payout_usd * 100), currency: "usd",
        destination: acct,
        description: `BBX impression revenue ${new Date(sinceTs).toISOString().slice(0,10)} – ${new Date(untilTs).toISOString().slice(0,10)}`,
        metadata: { publisher: t.publisher, impressions: String(t.impressions) },
      });
      t.stripe_transfer_id = tr.id;
    }
  }

  const summary = {
    period: { since: new Date(sinceTs).toISOString(), until: new Date(untilTs).toISOString() },
    take_rate: TAKE_RATE,
    min_payout_usd: MIN_PAYOUT_USD,
    publishers: transfers.length,
    eligible:   transfers.filter((t) => t.eligible).length,
    total_payout_usd: +transfers.filter((t) => t.eligible).reduce((s, t) => s + t.payout_usd, 0).toFixed(4),
    dry_run, mode: HAS_STRIPE ? "stripe" : "demo",
    transfers,
  };
  DEMO.payouts.set("payout_" + Date.now().toString(36), summary);
  return res.json(summary);
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

  DEMO.events.push({ at: new Date().toISOString(), type: event.type, untrusted: !!event.untrusted });

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const advertiserId = session.metadata && session.metadata.advertiser_id;
    const amount       = parseFloat((session.metadata && session.metadata.amount) || 0);
    if (advertiserId && amount > 0) {
      const sb = supa();
      if (sb) {
        // Atomic increment using RPC to avoid read-then-write race
        const { error: rpcErr } = await sb.rpc("bbx_credit_advertiser_balance", {
          p_advertiser_id: advertiserId,
          p_amount_usd: amount,
        });
        // Fallback: if the RPC doesn't exist, do read-then-write
        if (rpcErr && rpcErr.message && rpcErr.message.includes("does not exist")) {
          const { data: adv } = await sb.from("advertisers").select("balance").eq("id", advertiserId).single();
          if (adv) {
            await sb.from("advertisers")
              .update({ balance: parseFloat(adv.balance) + amount })
              .eq("id", advertiserId);
          }
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

  // Handle Stripe Connect account updates (publisher onboarding completion)
  if (event.type === "account.updated") {
    const account = event.data.object;
    if (account.charges_enabled && account.metadata && account.metadata.developer_id) {
      const sb = supa();
      if (sb) {
        await sb.from("developers")
          .update({ stripe_account_id: account.id, updated_at: new Date().toISOString() })
          .eq("id", account.metadata.developer_id);
      } else {
        const d = ensureDemoDeveloper(account.metadata.developer_id);
        d.stripe_account_id = account.id;
      }
    }
  }

  return res.json({ received: true, event_type: event.type, mode: HAS_STRIPE ? "stripe" : "demo" });
}

// ── helpers ────────────────────────────────────────────────────────────
function nextPayoutDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().split("T")[0];
}

// ── exports for testing ────────────────────────────────────────────────
module.exports.HAS_STRIPE   = HAS_STRIPE;
module.exports.HAS_SUPABASE = HAS_SUPABASE;
module.exports.TAKE_RATE    = TAKE_RATE;
module.exports._DEMO        = DEMO;
module.exports._reset = function () {
  DEMO.advertisers.clear();
  DEMO.developers.clear();
  DEMO.invoices.clear();
  DEMO.payouts.clear();
  DEMO.events.length = 0;
};
