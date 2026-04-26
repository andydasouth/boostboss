/**
 * Boost Boss — Auction Ledger
 *
 * Single source of truth for every event in the BBX auction lifecycle:
 *
 *   recordAuction(req, seat)            ← every BidRequest we accept
 *   recordBid(auctionId, bid)           ← every Bid we return
 *   recordWin(bidId, clearingPriceCpm)  ← every nurl callback (DSP cleared)
 *   recordLoss(bidId, reason)           ← every lurl callback (DSP lost)
 *   reportSpend(seatId, since, until)   ← what the DSP owes / what we owe pubs
 *   deductBudget(campaignId, amountUsd) ← atomic spend tracking on win
 *
 * Two execution modes — same interface so callers never branch:
 *   • PRODUCTION — Postgres via Supabase (when SUPABASE_URL is set)
 *   • DEMO       — in-process Map (resets on cold start; fine for testing,
 *                  preview deploys, and the public exchange page)
 *
 * Schema: see /db/03_rtb_ledger.sql
 */

const HAS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
);

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
  } catch (_) {
    return null;
  }
}

// ── In-process fallback storage ─────────────────────────────────────────
// Resets on cold start. That's deliberate — demo is meant to be ephemeral.
const MEM = {
  auctions: new Map(),     // auction_id → { id, seat_id, ts, tmax, raw }
  bids:     new Map(),     // bid_id     → { id, auction_id, imp_id, campaign_id, price_cpm, status, won_price_cpm, lost_reason }
  budgets:  new Map(),     // campaign_id → { spent_today, spent_total, daily_budget, total_budget, day_key }
};

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

// ── Public API ──────────────────────────────────────────────────────────

/** Record an incoming BidRequest. Returns the auction_id (echoes req.id).
 *  `extras` lets the caller materialise MCP-native targeting context onto
 *  the row alongside the raw OpenRTB body, matching the columns added in
 *  db/04_bbx_mcp_extensions.sql §4.
 */
async function recordAuction(bidReq, seatId = null, extras = {}) {
  const row = {
    id: bidReq.id,
    seat_id: seatId,
    ts: new Date().toISOString(),
    tmax: bidReq.tmax || 200,
    imp_count: (bidReq.imp || []).length,
    site_domain: (bidReq.site && bidReq.site.domain) || null,
    app_bundle: (bidReq.app && bidReq.app.bundle) || null,
    raw: bidReq, // we keep the full body for forensics; trim in prod if storage matters
    // MCP-native context (jsonb column added by migration 04). Stored even
    // if the SDK didn't pass intent_tokens — empty objects are harmless.
    mcp_context: extras.mcp_context || null,
    placement_id: extras.placement_id || null,
  };
  const sb = supa();
  if (sb) {
    const { error } = await sb.from("rtb_auctions").insert(row);
    if (error) console.error("[Ledger] auction insert:", error.message);
  } else {
    MEM.auctions.set(row.id, row);
  }
  return row.id;
}

/** Record a Bid we returned. Returns the stored bid record. */
async function recordBid(auctionId, bid, campaignId, seatId = "boostboss", extras = {}) {
  const row = {
    id: bid.id,
    auction_id: auctionId,
    imp_id: bid.impid,
    campaign_id: campaignId,
    seat_id: seatId,
    price_cpm: bid.price,
    adomain: bid.adomain || [],
    cat: bid.cat || [],
    developer_id: extras.developer_id || null,
    developer_domain: extras.developer_domain || null,
    status: "pending", // pending → won | lost | expired
    ts: new Date().toISOString(),
  };
  const sb = supa();
  if (sb) {
    const { error } = await sb.from("rtb_bids").insert(row);
    if (error) console.error("[Ledger] bid insert:", error.message);
  } else {
    MEM.bids.set(row.id, row);
  }
  return row;
}

/**
 * Record a win notice. Atomically deducts campaign budget by the clearing price
 * (converted from CPM to per-impression USD). Returns the updated bid record
 * or null if the bid was unknown.
 */
async function recordWin(bidId, clearingPriceCpm) {
  const priceCpm = Number(clearingPriceCpm) || 0;
  const sb = supa();
  if (sb) {
    // Single-row update — Postgres guarantees atomicity per row.
    const { data, error } = await sb
      .from("rtb_bids")
      .update({
        status: "won",
        won_price_cpm: priceCpm,
        won_at: new Date().toISOString(),
      })
      .eq("id", bidId)
      .eq("status", "pending") // idempotency: don't double-win
      .select()
      .single();
    if (error || !data) {
      console.error("[Ledger] win update miss:", bidId, error && error.message);
      return null;
    }
    // Budget deduction is a separate atomic call against advertisers.balance
    if (data.campaign_id) {
      await deductBudget(data.campaign_id, priceCpm / 1000);
    }
    return data;
  }

  // ── In-memory path ──
  const bid = MEM.bids.get(bidId);
  if (!bid) return null;
  if (bid.status !== "pending") return bid; // idempotent
  bid.status = "won";
  bid.won_price_cpm = priceCpm;
  bid.won_at = new Date().toISOString();
  if (bid.campaign_id) await deductBudget(bid.campaign_id, priceCpm / 1000);
  return bid;
}

/** Record a loss notice. */
async function recordLoss(bidId, reason) {
  const sb = supa();
  const reasonCode = Number(reason) || 0;
  if (sb) {
    const { data, error } = await sb
      .from("rtb_bids")
      .update({
        status: "lost",
        lost_reason: reasonCode,
        lost_at: new Date().toISOString(),
      })
      .eq("id", bidId)
      .eq("status", "pending")
      .select()
      .single();
    if (error || !data) return null;
    return data;
  }
  const bid = MEM.bids.get(bidId);
  if (!bid) return null;
  if (bid.status !== "pending") return bid;
  bid.status = "lost";
  bid.lost_reason = reasonCode;
  bid.lost_at = new Date().toISOString();
  return bid;
}

/**
 * Atomically deduct from a campaign's daily and total spend buckets.
 * Returns { spent_today, spent_total, daily_budget, total_budget } after deduction,
 * or null if the campaign is unknown / would exceed daily budget.
 */
async function deductBudget(campaignId, amountUsd) {
  if (amountUsd <= 0) return null;
  const sb = supa();
  if (sb) {
    // Use an RPC for true atomicity. The function is defined in 03_rtb_ledger.sql
    const { data, error } = await sb.rpc("bbx_deduct_campaign_budget", {
      p_campaign_id: campaignId,
      p_amount_usd: amountUsd,
    });
    if (error) {
      console.error("[Ledger] budget deduct:", error.message);
      return null;
    }
    return data;
  }

  // ── In-memory path ──
  const day = todayKey();
  let row = MEM.budgets.get(campaignId);
  if (!row) {
    row = { spent_today: 0, spent_total: 0, daily_budget: Infinity, total_budget: Infinity, day_key: day };
    MEM.budgets.set(campaignId, row);
  }
  if (row.day_key !== day) { row.spent_today = 0; row.day_key = day; }
  row.spent_today += amountUsd;
  row.spent_total += amountUsd;
  return { ...row };
}

/** Initialize / refresh a campaign's budget caps in the in-memory store. */
function setBudgetCaps(campaignId, caps = {}) {
  const day = todayKey();
  const existing = MEM.budgets.get(campaignId) || { spent_today: 0, spent_total: 0, day_key: day };
  MEM.budgets.set(campaignId, {
    ...existing,
    daily_budget: caps.daily_budget != null ? caps.daily_budget : (existing.daily_budget ?? Infinity),
    total_budget: caps.total_budget != null ? caps.total_budget : (existing.total_budget ?? Infinity),
  });
}

/** Read current spend for a campaign (in-memory only — Supabase reads from `campaigns` table directly). */
function getBudgetState(campaignId) {
  const row = MEM.budgets.get(campaignId);
  if (!row) return { spent_today: 0, spent_total: 0, daily_budget: Infinity, total_budget: Infinity };
  const day = todayKey();
  if (row.day_key !== day) return { ...row, spent_today: 0, day_key: day };
  return { ...row };
}

/**
 * Aggregate spend report for a seat. Returns:
 *   { seat_id, since, until, requests, bids, wins, losses, gross_spend_usd, win_rate, avg_cpm }
 */
async function reportSpend(seatId, since, until) {
  const sinceTs = since ? new Date(since) : new Date(Date.now() - 30 * 86400 * 1000);
  const untilTs = until ? new Date(until) : new Date();
  const sb = supa();

  if (sb) {
    const { data: aucs } = await sb
      .from("rtb_auctions")
      .select("id")
      .eq("seat_id", seatId)
      .gte("ts", sinceTs.toISOString())
      .lte("ts", untilTs.toISOString());
    const requests = (aucs || []).length;

    const { data: bids } = await sb
      .from("rtb_bids")
      .select("status, won_price_cpm")
      .eq("seat_id", seatId)
      .gte("ts", sinceTs.toISOString())
      .lte("ts", untilTs.toISOString());

    return summarize(seatId, sinceTs, untilTs, requests, bids || []);
  }

  // ── In-memory path ──
  const aucs = [...MEM.auctions.values()].filter(
    (a) => a.seat_id === seatId &&
      new Date(a.ts) >= sinceTs && new Date(a.ts) <= untilTs
  );
  const bids = [...MEM.bids.values()].filter(
    (b) => b.seat_id === seatId &&
      new Date(b.ts) >= sinceTs && new Date(b.ts) <= untilTs
  );
  return summarize(seatId, sinceTs, untilTs, aucs.length, bids);
}

function summarize(seatId, since, until, requests, bids) {
  const wins = bids.filter((b) => b.status === "won");
  const losses = bids.filter((b) => b.status === "lost");
  const grossCpmSum = wins.reduce((s, b) => s + (Number(b.won_price_cpm) || 0), 0);
  const grossSpendUsd = grossCpmSum / 1000; // CPM → USD per imp summed
  return {
    seat_id: seatId,
    since: since.toISOString(),
    until: until.toISOString(),
    requests,
    bids: bids.length,
    wins: wins.length,
    losses: losses.length,
    gross_spend_usd: +grossSpendUsd.toFixed(4),
    win_rate: bids.length ? +(wins.length / bids.length).toFixed(4) : 0,
    avg_cpm_won: wins.length ? +(grossCpmSum / wins.length).toFixed(4) : 0,
  };
}

// ── Test/admin helpers ─────────────────────────────────────────────────
function _reset() {
  MEM.auctions.clear();
  MEM.bids.clear();
  MEM.budgets.clear();
}
function _dump() {
  return {
    auctions: [...MEM.auctions.values()],
    bids: [...MEM.bids.values()],
    budgets: [...MEM.budgets.entries()].map(([k, v]) => ({ campaign_id: k, ...v })),
  };
}

module.exports = {
  recordAuction,
  recordBid,
  recordWin,
  recordLoss,
  deductBudget,
  setBudgetCaps,
  getBudgetState,
  reportSpend,
  HAS_SUPABASE,
  _reset,
  _dump,
};
