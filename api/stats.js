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

// Import campaigns for demo. _DEMO_CAMPAIGNS is a Map in campaigns.js,
// so materialize its values into an array for .filter()/.map() use here.
function demoCampaigns() {
  try {
    const raw = require("./campaigns.js")._DEMO_CAMPAIGNS;
    if (raw && typeof raw.values === "function") return Array.from(raw.values());
    return Array.isArray(raw) ? raw : [];
  } catch (_) { return []; }
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
  // Restrict CORS in production to BoostBoss origins; allow * in demo for local dev
  const PUBLIC_BASE = process.env.BOOSTBOSS_BASE_URL || "https://boostboss.ai";
  if (HAS_SUPABASE) {
    const origin = req.headers && req.headers.origin;
    const allowed = ["https://boostboss.ai", "https://www.boostboss.ai", PUBLIC_BASE];
    res.setHeader("Access-Control-Allow-Origin", allowed.includes(origin) ? origin : PUBLIC_BASE);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("x-stats-mode", HAS_SUPABASE ? "supabase" : "demo");
  // Diagnostic: surface whether we're using the service role (bypasses
  // RLS) or the anon key (will hit RLS policies). RLS on events filters
  // by auth.uid() = developer_id, so anon-key reads always return zero
  // for cross-user queries — making this header essential for debugging.
  res.setHeader("x-stats-key-type",
    process.env.SUPABASE_SERVICE_ROLE_KEY ? "service_role" :
    process.env.SUPABASE_ANON_KEY ? "anon (RLS-restricted)" : "none");
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
    // Aggregate runs daily via Vercel cron (GET) and can also be triggered
    // manually via POST. Vercel crons only send GET, so we accept both.
    if (type === "aggregate" && (req.method === "POST" || req.method === "GET")) {
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

      // Merge in live events for the last 7 days. daily_stats is only
      // populated by the aggregate cron, so without this merge a brand-new
      // advertiser sees zero impressions even after their ad was served.
      dailyStats = await mergeLiveEvents(sb, dailyStats, { campaignIds });
    }

    const totals = rollUpTotals(dailyStats);

    // BBX auction-level breakdowns — give the advertiser dashboard its
    // intent-match, surface, and recent-auction panels backed by real data.
    const auction_summary = await loadAdvertiserAuctionSummary(sb, campaignIds);

    return res.json({
      campaigns: campaigns || [],
      daily: dailyStats,
      totals,
      auction_summary,
    });
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
  // Demo auction summary from in-memory events
  const auction_summary = demoAdvertiserAuctionSummary(events, campaigns.map(c => c.id));
  return res.json({ campaigns, daily: dailyStats, totals, auction_summary });
}

// ── Auction summary helpers ──────────────────────────────────────────
// Surfaces what the advertiser dashboard needs to render its "Benna engine"
// panel from real data: intent-match histogram, per-surface breakdown,
// recent-impression sample.
async function loadAdvertiserAuctionSummary(sb, campaignIds) {
  const empty = {
    impressions_with_intent: 0,
    avg_intent_match: null,
    intent_buckets: { high: 0, mid: 0, low: 0 },
    by_surface: {},
    by_format: {},
    recent: [],
  };
  if (!Array.isArray(campaignIds) || campaignIds.length === 0) return empty;
  try {
    const sinceIso = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: rows } = await sb.from("events")
      .select("event_type, surface, format, intent_match_score, cost, created_at, auction_id, placement_id, campaign_id, conversion_type, value_cents, currency")
      .in("campaign_id", campaignIds)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(2000);
    return summariseAuctionRows(rows || []);
  } catch (e) {
    console.error("[Stats] auction summary failed:", e.message);
    return empty;
  }
}

function demoAdvertiserAuctionSummary(events, campaignIds) {
  const ids = new Set((campaignIds || []).map(String));
  const filtered = (events || []).filter(e => ids.has(String(e.campaign_id)));
  return summariseAuctionRows(filtered);
}

function summariseAuctionRows(rows) {
  let withIntent = 0, sumIntent = 0;
  let convCount = 0, convValue = 0, totalSpend = 0, impCount = 0, clickCount = 0;
  const buckets = { high: 0, mid: 0, low: 0 };
  const byType  = {};   // counts by conversion_type
  const bySurface = {};
  const byFormat  = {};
  for (const r of rows) {
    if (r.event_type === "impression") {
      impCount++;
      totalSpend += Number(r.cost || 0);
      if (r.intent_match_score != null) {
        const s = Number(r.intent_match_score);
        withIntent++;
        sumIntent += s;
        if (s >= 1.2) buckets.high++;
        else if (s >= 0.7) buckets.mid++;
        else buckets.low++;
      }
      if (r.surface) {
        const s = bySurface[r.surface] || { impressions: 0, spend: 0 };
        s.impressions++; s.spend += Number(r.cost || 0);
        bySurface[r.surface] = s;
      }
      if (r.format) {
        const f = byFormat[r.format] || { impressions: 0, spend: 0 };
        f.impressions++; f.spend += Number(r.cost || 0);
        byFormat[r.format] = f;
      }
    } else if (r.event_type === "click") {
      clickCount++;
    } else if (r.event_type === "conversion") {
      convCount++;
      // value_cents stored as int; expose as dollars for display.
      convValue += (Number(r.value_cents || 0) / 100);
      const t = r.conversion_type || "uncategorised";
      byType[t] = (byType[t] || 0) + 1;
    }
  }
  // Latest 10 impressions for the "recent activity" feed
  const recent = rows
    .filter(r => r.event_type === "impression")
    .slice(0, 10)
    .map(r => ({
      ts: r.created_at, auction_id: r.auction_id || null,
      placement_id: r.placement_id || null,
      surface: r.surface || null, format: r.format || null,
      intent_match: r.intent_match_score != null ? Number(r.intent_match_score) : null,
      cost: r.cost != null ? Number(r.cost) : null,
    }));
  Object.values(bySurface).forEach(s => s.spend = +s.spend.toFixed(4));
  Object.values(byFormat).forEach(f => f.spend  = +f.spend.toFixed(4));
  // ROAS = total conversion value / total ad spend. Null when no spend.
  const roas = totalSpend > 0 ? +(convValue / totalSpend).toFixed(4) : null;
  // CPA = spend / conversions. Null when no conversions.
  const cpa  = convCount > 0 ? +(totalSpend / convCount).toFixed(4) : null;
  return {
    impressions_with_intent: withIntent,
    avg_intent_match: withIntent > 0 ? +(sumIntent / withIntent).toFixed(4) : null,
    intent_buckets: buckets,
    by_surface: bySurface,
    by_format:  byFormat,
    recent,
    // Conversion summary (protocol §6.2)
    conversions: {
      count: convCount,
      value:  +convValue.toFixed(2),
      currency: "USD",
      by_type: byType,
      cvr: clickCount > 0 ? +(convCount / clickCount).toFixed(4) : null,
      roas, cpa,
    },
  };
}

// ── Developer stats ───────────────────────────────────────────────────
async function handleDeveloperStats(devKey, req, res) {
  const sb = supa();

  if (sb) {
    const { data: dev, error: dErr } = await sb
      .from("developers").select("*").eq("api_key", devKey).single();
    if (dErr || !dev) return res.status(404).json({ error: "Developer not found", detail: dErr?.message });

    let { data: dailyStats } = await sb.from("daily_stats").select("*")
      .eq("developer_id", dev.id).order("date", { ascending: true }).limit(60);
    dailyStats = dailyStats || [];

    // Merge in live events from the last 7 days so brand-new publishers
    // see their first impressions immediately (not after the nightly
    // aggregate cron).
    dailyStats = await mergeLiveEvents(sb, dailyStats, { developerId: dev.id });

    // Per-placement breakdown — pulls from the placement_daily_stats view
    // (created by migration 04). Joined with placements so we have surface
    // / format / status without a second round-trip.
    const placements = await loadPlacementBreakdown(sb, dev.id);

    const totals = rollUpDevTotals(dailyStats);
    return res.json({
      developer: formatDeveloper(dev),
      daily: dailyStats,
      totals,
      placements,
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

  // Demo placement breakdown — derive from the in-memory events we just rolled up.
  const placements = demoPlacementBreakdown(events, devKey);

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
    placements,
  });
}

// ── Placement breakdown helpers ───────────────────────────────────────
// Pulls per-placement metrics for a publisher dashboard. Reads the
// placement_daily_stats view (migration 04) joined with placements so
// we get human-readable name + status alongside the numbers.
async function loadPlacementBreakdown(sb, developerId) {
  try {
    const sinceDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const { data: rows, error } = await sb.from("placement_daily_stats")
      .select("placement_id, surface, format, impressions, clicks, video_completes, gross_spend, publisher_earnings, ecpm, ctr, avg_intent_match")
      .eq("developer_id", developerId)
      .gte("date", sinceDate);
    if (error || !rows) return [];

    // Aggregate across days into per-placement totals
    const byPlacement = new Map();
    for (const r of rows) {
      const k = r.placement_id;
      if (!k) continue;
      if (!byPlacement.has(k)) {
        byPlacement.set(k, {
          placement_id: k, surface: r.surface, format: r.format,
          impressions: 0, clicks: 0, video_completes: 0,
          gross_spend: 0, publisher_earnings: 0,
          intent_match_sum: 0, intent_match_n: 0,
        });
      }
      const b = byPlacement.get(k);
      b.impressions       += Number(r.impressions || 0);
      b.clicks            += Number(r.clicks || 0);
      b.video_completes   += Number(r.video_completes || 0);
      b.gross_spend       += Number(r.gross_spend || 0);
      b.publisher_earnings+= Number(r.publisher_earnings || 0);
      if (r.avg_intent_match != null) {
        b.intent_match_sum += Number(r.avg_intent_match);
        b.intent_match_n   += 1;
      }
    }

    // Hydrate with placement metadata (name, status, floor)
    const ids = [...byPlacement.keys()];
    if (ids.length === 0) return [];
    const { data: meta } = await sb.from("placements")
      .select("id, name, surface, format, floor_cpm, status")
      .in("id", ids);
    const metaById = new Map((meta || []).map(m => [m.id, m]));

    return [...byPlacement.values()].map(b => {
      const m = metaById.get(b.placement_id) || {};
      const ecpm = b.impressions > 0 ? (b.gross_spend / b.impressions) * 1000 : 0;
      const ctr  = b.impressions > 0 ? (b.clicks / b.impressions) : 0;
      return {
        placement_id: b.placement_id,
        name: m.name || b.placement_id,
        surface: b.surface || m.surface,
        format:  b.format  || m.format,
        floor_cpm: m.floor_cpm != null ? Number(m.floor_cpm) : null,
        status:  m.status || "unknown",
        impressions: b.impressions,
        clicks: b.clicks,
        video_completes: b.video_completes,
        gross_spend:        +b.gross_spend.toFixed(4),
        publisher_earnings: +b.publisher_earnings.toFixed(4),
        ecpm: +ecpm.toFixed(4),
        ctr:  +ctr.toFixed(4),
        avg_intent_match: b.intent_match_n > 0
          ? +(b.intent_match_sum / b.intent_match_n).toFixed(4)
          : null,
      };
    }).sort((a, b) => b.publisher_earnings - a.publisher_earnings);
  } catch (e) {
    console.error("[Stats] placement breakdown failed:", e.message);
    return [];
  }
}

// Demo equivalent — derive placement metrics from in-memory events for a
// given developer key. Used only when SUPABASE env is missing.
function demoPlacementBreakdown(events, devKey) {
  const byPlacement = new Map();
  for (const ev of events || []) {
    if (devKey && ev.developer_id !== devKey) continue;
    if (!ev.placement_id) continue;
    const k = ev.placement_id;
    if (!byPlacement.has(k)) {
      byPlacement.set(k, {
        placement_id: k, surface: ev.surface || null, format: ev.format || null,
        impressions: 0, clicks: 0, video_completes: 0,
        gross_spend: 0, publisher_earnings: 0,
        intent_match_sum: 0, intent_match_n: 0,
      });
    }
    const b = byPlacement.get(k);
    if (ev.event_type === "impression") b.impressions++;
    if (ev.event_type === "click") b.clicks++;
    if (ev.event_type === "video_complete") b.video_completes++;
    b.gross_spend        += Number(ev.cost || 0);
    b.publisher_earnings += Number(ev.developer_payout || 0);
    if (ev.intent_match_score != null) {
      b.intent_match_sum += Number(ev.intent_match_score);
      b.intent_match_n   += 1;
    }
  }
  return [...byPlacement.values()].map(b => {
    const ecpm = b.impressions > 0 ? (b.gross_spend / b.impressions) * 1000 : 0;
    const ctr  = b.impressions > 0 ? (b.clicks / b.impressions) : 0;
    return {
      placement_id: b.placement_id,
      name: b.placement_id,
      surface: b.surface, format: b.format,
      floor_cpm: null, status: "active",
      impressions: b.impressions, clicks: b.clicks, video_completes: b.video_completes,
      gross_spend:        +b.gross_spend.toFixed(4),
      publisher_earnings: +b.publisher_earnings.toFixed(4),
      ecpm: +ecpm.toFixed(4), ctr: +ctr.toFixed(4),
      avg_intent_match: b.intent_match_n > 0
        ? +(b.intent_match_sum / b.intent_match_n).toFixed(4) : null,
    };
  }).sort((a, b) => b.publisher_earnings - a.publisher_earnings);
}

// ── Helpers ────────────────────────────────────────────────────────────
function rollUpTotals(dailyStats) {
  let totalImpressions = 0, totalClicks = 0, totalSpend = 0;
  for (const s of dailyStats) {
    totalImpressions += s.impressions || 0;
    totalClicks += s.clicks || 0;
    const sp = parseFloat(s.spend || 0);
    totalSpend += Number.isFinite(sp) ? sp : 0;
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
    const de = parseFloat(s.developer_earnings || 0);
    totalEarnings += Number.isFinite(de) ? de : 0;
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
      native:     dev.format_native,
      image:      dev.format_image,
      corner:     dev.format_corner,
      video:      dev.format_video,
      fullscreen: dev.format_fullscreen,
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
    const evCost = parseFloat(ev.cost);
    b.spend += Number.isFinite(evCost) ? evCost : 0;
    const evPayout = parseFloat(ev.developer_payout);
    b.developer_earnings += Number.isFinite(evPayout) ? evPayout : 0;
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

// ── Live-events merge ─────────────────────────────────────────────────
// Pulls the past N days of raw events from the events table and rolls
// them up by date, then merges over the daily_stats array so fresh
// impressions show up without waiting for the aggregate cron. Accepts
// either { campaignIds } (advertiser view) or { developerId } (publisher
// view) as the filter. Silently returns the input on any error — we
// never want to break the dashboard over a fallback-merge failure.
async function mergeLiveEvents(sb, dailyStats, filter) {
  try {
    const sinceDate = new Date(Date.now() - 7 * 86400000);
    const sinceIso = sinceDate.toISOString();
    let q = sb.from("events")
      .select("event_type, campaign_id, developer_id, cost, developer_payout, created_at")
      .gte("created_at", sinceIso);
    if (filter.campaignIds && filter.campaignIds.length) q = q.in("campaign_id", filter.campaignIds);
    if (filter.developerId) q = q.eq("developer_id", filter.developerId);

    const { data: events, error } = await q;
    if (error || !events || events.length === 0) return dailyStats;

    // Roll up events by (date, campaign_id, developer_id)
    const buckets = new Map();
    for (const ev of events) {
      const date = (ev.created_at || "").slice(0, 10);
      const key = `${date}|${ev.campaign_id || "null"}|${ev.developer_id || "null"}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          date,
          campaign_id: ev.campaign_id || null,
          developer_id: ev.developer_id || null,
          impressions: 0, clicks: 0, conversions: 0,
          spend: 0, developer_earnings: 0,
        });
      }
      const b = buckets.get(key);
      if (ev.event_type === "impression") b.impressions++;
      else if (ev.event_type === "click") b.clicks++;
      else if (ev.event_type === "video_complete") b.conversions++;
      b.spend += Number(ev.cost || 0);
      b.developer_earnings += Number(ev.developer_payout || 0);
    }

    // Replace any matching rows in dailyStats with live rollups, append new.
    const live = [...buckets.values()];
    const filtered = (dailyStats || []).filter(d => {
      return !live.some(l =>
        l.date === d.date &&
        (l.campaign_id || null) === (d.campaign_id || null) &&
        (l.developer_id || null) === (d.developer_id || null)
      );
    });
    return [...filtered, ...live].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  } catch (_) {
    return dailyStats;
  }
}

// ── Exports for testing ───────────────────────────────────────────────
module.exports.HAS_SUPABASE = HAS_SUPABASE;
