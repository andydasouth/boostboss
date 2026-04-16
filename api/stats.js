/**
 * Boost Boss — Stats API
 *
 * Two modes:
 *   • PRODUCTION — Supabase (daily_stats + campaigns + developers)
 *   • DEMO       — in-process seeded data, same response shape
 *
 * GET /api/stats?type=advertiser&id=xxx
 * GET /api/stats?type=developer&key=xxx
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
  } catch (_) { return null; }
}

// ── Demo data generation ──────────────────────────────────────────────
// Deterministic seeded PRNG so numbers are stable within a session
function seeded(seed) {
  let x = Math.abs(seed) || 1;
  return () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Import campaigns for demo
let _campaigns;
function demoCampaigns() {
  if (_campaigns) return _campaigns;
  try { _campaigns = require("./campaigns.js")._DEMO_CAMPAIGNS || []; } catch (_) { _campaigns = []; }
  return _campaigns;
}

// Import track events for demo
let _trackEvents;
function demoEvents() {
  try { return require("./track.js")._DEMO_EVENTS || []; } catch (_) { return []; }
}

// Import ledger for demo
let _ledger;
function demoLedger() {
  try { return require("./_lib/ledger.js")._dump(); } catch (_) { return { auctions: [], bids: [], budgets: [] }; }
}

function generateDailyStats(id, days = 30) {
  const rng = seeded(hashCode(id));
  const stats = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const baseImps = 800 + Math.floor(rng() * 1200);
    const impressions = baseImps + Math.floor(rng() * 400);
    const ctr = 0.03 + rng() * 0.05;
    const clicks = Math.floor(impressions * ctr);
    const cpc = 0.15 + rng() * 0.25;
    const spend = +(clicks * cpc).toFixed(2);
    const devEarnings = +(spend * 0.85).toFixed(2);
    stats.push({
      date: dateStr,
      impressions,
      clicks,
      spend,
      developer_earnings: devEarnings,
    });
  }
  return stats;
}

// ── Handler ───────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("x-stats-mode", HAS_SUPABASE ? "supabase" : "demo");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { type, id, key: devKey } = req.query;

    // ── Advertiser Stats ──
    if (type === "advertiser" && id) {
      return await handleAdvertiserStats(id, req, res);
    }

    // ── Developer Stats ──
    if (type === "developer" && devKey) {
      return await handleDeveloperStats(devKey, req, res);
    }

    // ── Daily Stats ETL ── (POST /api/stats?type=aggregate)
    // Rolls up events into daily_stats table. Designed to be called by cron.
    if (type === "aggregate" && req.method === "POST") {
      return await handleAggregate(req, res);
    }

    return res.status(400).json({ error: "Missing type (advertiser|developer) and id/key params" });

  } catch (err) {
    console.error("[BoostBoss Stats Error]", err);
    return res.status(500).json({ error: "Internal server error", message: err.message });
  }
};

// ── Advertiser stats ──────────────────────────────────────────────────
async function handleAdvertiserStats(id, req, res) {
  const sb = supa();

  if (sb) {
    const { data: campaigns, error: cErr } = await sb
      .from("campaigns").select("*").eq("advertiser_id", id)
      .order("created_at", { ascending: false });
    if (cErr) return res.status(500).json({ error: cErr.message });

    const campaignIds = (campaigns || []).map(c => c.id);
    let dailyStats = [];
    if (campaignIds.length > 0) {
      const { data } = await sb.from("daily_stats").select("*")
        .in("campaign_id", campaignIds)
        .order("date", { ascending: true }).limit(60);
      dailyStats = data || [];
    }

    const totals = rollUpTotals(dailyStats);
    return res.json({ campaigns: campaigns || [], daily: dailyStats, totals });
  }

  // ── Demo fallback: use real in-memory data + seeded history ──
  const allCampaigns = demoCampaigns();
  const campaigns = allCampaigns.filter(c => c.advertiser_id === id);

  // If no campaigns match, generate for the ID (covers demo accounts)
  if (campaigns.length === 0) {
    campaigns.push(...allCampaigns.filter(c => c.status === "active").slice(0, 2).map(c => ({
      ...c, advertiser_id: id,
    })));
  }

  // Merge seeded daily stats with real ledger data
  const dailyStats = generateDailyStats(id, 30);

  // Overlay real events from tracking
  const events = demoEvents();
  for (const ev of events) {
    if (ev.event_type !== "impression") continue;
    const camp = campaigns.find(c => c.id === ev.campaign_id);
    if (!camp) continue;
    const dateStr = (ev.created_at || "").slice(0, 10);
    const day = dailyStats.find(d => d.date === dateStr);
    if (day) {
      day.impressions += 1;
      day.spend += ev.cost || 0;
    }
  }

  const totals = rollUpTotals(dailyStats);
  return res.json({ campaigns, daily: dailyStats, totals });
}

// ── Developer stats ───────────────────────────────────────────────────
async function handleDeveloperStats(devKey, req, res) {
  const sb = supa();

  if (sb) {
    const { data: dev, error: dErr } = await sb
      .from("developers").select("*").eq("api_key", devKey).single();
    if (dErr || !dev) return res.status(404).json({ error: "Developer not found", detail: dErr?.message });

    const { data: dailyStats } = await sb.from("daily_stats").select("*")
      .eq("developer_id", dev.id).order("date", { ascending: true }).limit(60);

    const totals = rollUpDevTotals(dailyStats || []);
    return res.json({
      developer: formatDeveloper(dev),
      daily: dailyStats || [],
      totals,
    });
  }

  // ── Demo fallback ──
  const dailyStats = generateDailyStats(devKey, 30);

  // Overlay real events from tracking
  const events = demoEvents();
  for (const ev of events) {
    if (ev.developer_id !== devKey) continue;
    const dateStr = (ev.created_at || "").slice(0, 10);
    const day = dailyStats.find(d => d.date === dateStr);
    if (day) {
      if (ev.event_type === "impression") day.impressions += 1;
      if (ev.event_type === "click") day.clicks += 1;
      day.developer_earnings += ev.developer_payout || 0;
    }
  }

  const totals = rollUpDevTotals(dailyStats);
  return res.json({
    developer: {
      id: devKey,
      app_name: "My AI App",
      api_key: devKey,
      app_id: "app_demo",
      revenue_share_pct: 85,
      formats: { corner: true, fullscreen: false, video: true, native: true },
    },
    daily: dailyStats,
    totals,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────
function rollUpTotals(dailyStats) {
  let totalImpressions = 0, totalClicks = 0, totalSpend = 0;
  for (const s of dailyStats) {
    totalImpressions += s.impressions || 0;
    totalClicks += s.clicks || 0;
    totalSpend += parseFloat(s.spend || 0);
  }
  return {
    impressions: totalImpressions,
    clicks: totalClicks,
    ctr: totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : "0.00",
    spend: totalSpend.toFixed(2),
  };
}

function rollUpDevTotals(dailyStats) {
  let totalImpressions = 0, totalClicks = 0, totalEarnings = 0;
  for (const s of dailyStats) {
    totalImpressions += s.impressions || 0;
    totalClicks += s.clicks || 0;
    totalEarnings += parseFloat(s.developer_earnings || 0);
  }
  return {
    impressions: totalImpressions,
    clicks: totalClicks,
    earnings: totalEarnings.toFixed(2),
    rpm: totalImpressions > 0 ? ((totalEarnings / totalImpressions) * 1000).toFixed(2) : "0.00",
  };
}

function formatDeveloper(dev) {
  return {
    id: dev.id,
    app_name: dev.app_name,
    api_key: dev.api_key,
    app_id: dev.app_id,
    revenue_share_pct: dev.revenue_share_pct,
    formats: {
      corner: dev.format_corner,
      fullscreen: dev.format_fullscreen,
      video: dev.format_video,
      native: dev.format_native,
    },
  };
}

// ── Daily Stats ETL ──────────────────────────────────────────────────
// Aggregates the events table into daily_stats for a given date.
// Idempotent: uses UPSERT on the (date, campaign_id, developer_id) unique key.
// Call via: POST /api/stats?type=aggregate&date=2026-04-15
// If no date param, defaults to yesterday (safe for cron at midnight).
async function handleAggregate(req, res) {
  const dateParam = (req.query && req.query.date) || (req.body && req.body.date);
  const targetDate = dateParam || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const sb = supa();
  if (!sb) {
    // Demo mode: aggregate from in-memory events
    const events = demoEvents();
    const buckets = new Map();
    for (const ev of events) {
      const evDate = (ev.created_at || "").slice(0, 10);
      if (evDate !== targetDate) continue;
      const key = `${ev.campaign_id}|${ev.developer_id || "none"}`;
      const b = buckets.get(key) || {
        date: targetDate, campaign_id: ev.campaign_id,
        developer_id: ev.developer_id || null,
        impressions: 0, clicks: 0, video_completes: 0, skips: 0, closes: 0,
        spend: 0, developer_earnings: 0,
      };
      if (ev.event_type === "impression") b.impressions++;
      if (ev.event_type === "click") b.clicks++;
      if (ev.event_type === "video_complete") b.video_completes++;
      if (ev.event_type === "skip") b.skips++;
      if (ev.event_type === "close") b.closes++;
      b.spend += ev.cost || 0;
      b.developer_earnings += ev.developer_payout || 0;
      buckets.set(key, b);
    }
    const rows = [...buckets.values()].map(b => ({
      ...b, spend: +b.spend.toFixed(2), developer_earnings: +b.developer_earnings.toFixed(2),
    }));
    return res.json({
      mode: "demo", date: targetDate, rows_upserted: rows.length, rows,
    });
  }

  // Production: SQL aggregation + upsert into daily_stats
  // Step 1: Aggregate events for the target date
  const { data: agg, error: aggErr } = await sb.rpc("bbx_aggregate_daily_stats", {
    p_date: targetDate,
  });

  if (aggErr) {
    // If the RPC doesn't exist yet, fall back to client-side aggregation
    if (aggErr.message && aggErr.message.includes("does not exist")) {
      return await handleAggregateClientSide(sb, targetDate, res);
    }
    return res.status(500).json({ error: aggErr.message });
  }

  return res.json({
    mode: "supabase", date: targetDate,
    rows_upserted: Array.isArray(agg) ? agg.length : 1,
    message: "Daily stats aggregated successfully",
  });
}

// Client-side aggregation fallback (before the DB RPC is deployed)
async function handleAggregateClientSide(sb, targetDate, res) {
  const dayStart = `${targetDate}T00:00:00Z`;
  const dayEnd = `${targetDate}T23:59:59.999Z`;

  const { data: events, error } = await sb.from("events")
    .select("event_type, campaign_id, developer_id, cost, developer_payout")
    .gte("created_at", dayStart)
    .lte("created_at", dayEnd);

  if (error) return res.status(500).json({ error: error.message });

  const buckets = new Map();
  for (const ev of (events || [])) {
    const key = `${ev.campaign_id}|${ev.developer_id || "null"}`;
    const b = buckets.get(key) || {
      date: targetDate, campaign_id: ev.campaign_id,
      developer_id: ev.developer_id || null,
      impressions: 0, clicks: 0, video_completes: 0, skips: 0, closes: 0,
      spend: 0, developer_earnings: 0,
    };
    if (ev.event_type === "impression") b.impressions++;
    if (ev.event_type === "click") b.clicks++;
    if (ev.event_type === "video_complete") b.video_completes++;
    if (ev.event_type === "skip") b.skips++;
    if (ev.event_type === "close") b.closes++;
    b.spend += parseFloat(ev.cost) || 0;
    b.developer_earnings += parseFloat(ev.developer_payout) || 0;
    buckets.set(key, b);
  }

  // Upsert each bucket into daily_stats
  let upserted = 0;
  for (const row of buckets.values()) {
    row.spend = +row.spend.toFixed(2);
    row.developer_earnings = +row.developer_earnings.toFixed(2);
    const { error: uErr } = await sb.from("daily_stats").upsert(row, {
      onConflict: "date,campaign_id,developer_id",
    });
    if (!uErr) upserted++;
  }

  return res.json({
    mode: "supabase", date: targetDate,
    rows_upserted: upserted,
    message: "Daily stats aggregated (client-side fallback)",
  });
}

// ── Exports for testing ───────────────────────────────────────────────
module.exports.HAS_SUPABASE = HAS_SUPABASE;
