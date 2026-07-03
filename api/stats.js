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

const { resolveAdvertiser } = require("./_lib/advertiser_auth.js");

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

    // ── Reconciliation (Phase A — silent-failure observability) ──
    // Compares auction wins to impression events over the last 24h. Drops
    // below threshold mean impression beacons are silently failing
    // somewhere — exactly the failure mode we hit 2026-05-08 (uuid type
    // mismatch). Designed to be called by cron every 6h. See Phase A in
    // the validation report at db/VALIDATION-2026-05-08.md.
    if (type === "recon" && (req.method === "POST" || req.method === "GET")) {
      return await handleRecon(req, res);
    }

    // ── Live Activity (Phase H Panel 1 — hospital-monitor view) ──
    // Single round-trip "is the machine healthy?" panel for the admin
    // console. Returns health / volume / money / top-publishers /
    // top-campaigns / by-door / recent-alerts in one JSON. Admin-gated.
    if (type === "live_activity" && req.method === "GET") {
      return await handleLiveActivity(req, res);
    }

    // ── Money Flow (Phase H Panel 2 — full financial picture) ──
    // Multi-window financial dashboard: advertiser deposits, spend, BB
    // take, publisher accrual, payouts paid, pending clawbacks, balance
    // health, eligible-for-next-payout. Admin-gated.
    if (type === "money_flow" && req.method === "GET") {
      return await handleMoneyFlow(req, res);
    }

    // ── Auction Inspector (Phase H Panel 3 — per-auction replay) ──
    // Two modes:
    //   list:   ?type=auction_inspect&limit=N&outcome=X&publisher_id=Y
    //   detail: ?type=auction_inspect&id=AUCTION_ID
    // Admin-gated. Reads auction_logs (db/08_auction_logs.sql).
    if (type === "auction_inspect" && req.method === "GET") {
      return await handleAuctionInspect(req, res);
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
    // ── Cross-tenant fix ─────────────────────────────────────────────
    // The advertiser is derived from the Bearer credential (API key OR
    // session JWT); the query-string ?id is IGNORED for scoping so a
    // caller can only ever read its OWN stats. The dashboard already
    // sends its own id + Bearer, so this is backward-compatible.
    const auth = await resolveAdvertiser(req, sb);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    const authedAdvertiserId = auth.advertiserId;

    const { data: campaigns, error: cErr } = await sb
      .from("campaigns").select("*").eq("advertiser_id", authedAdvertiserId)
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
    by_integration_method: {},
    recent: [],
  };
  if (!Array.isArray(campaignIds) || campaignIds.length === 0) return empty;
  try {
    const sinceIso = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: rows } = await sb.from("events")
      .select("event_type, surface, format, integration_method, intent_match_score, cost, created_at, auction_id, placement_id, campaign_id, conversion_type, value_cents, currency")
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
  // Per-door breakdown — events are tagged with integration_method
  // (mcp / js-snippet / npm-sdk / rest-api) by db/06_integration_method.sql.
  // Each method maps 1:1 to one of Boost Boss's four publisher integration
  // doors, so the advertiser dashboard can show "where your spend went"
  // grouped by surface family rather than just by lower-level surface flag.
  const byIntegrationMethod = {};
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
      const im = r.integration_method || "untagged";
      const m = byIntegrationMethod[im] || { impressions: 0, clicks: 0, spend: 0 };
      m.impressions++; m.spend += Number(r.cost || 0);
      byIntegrationMethod[im] = m;
    } else if (r.event_type === "click") {
      clickCount++;
      const im = r.integration_method || "untagged";
      const m = byIntegrationMethod[im] || { impressions: 0, clicks: 0, spend: 0 };
      m.clicks++;
      byIntegrationMethod[im] = m;
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
  Object.values(byIntegrationMethod).forEach(m => { m.spend = +m.spend.toFixed(4); });
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
    by_integration_method: byIntegrationMethod,
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

  // Optional filter by integration door (mcp / js-snippet / npm-sdk / rest-api).
  // Defaults to "all" which leaves the existing global-aggregate behaviour
  // unchanged. When a specific door is passed, we recompute daily + totals
  // from the events table directly (daily_stats lacks the column).
  const VALID_METHODS = ["mcp", "js-snippet", "npm-sdk", "rest-api"];
  const filterMethod = (req.query && typeof req.query.integration_method === "string"
    && VALID_METHODS.includes(req.query.integration_method))
    ? req.query.integration_method : null;

  if (sb) {
    const { data: dev, error: dErr } = await sb
      .from("developers").select("*").eq("api_key", devKey).single();
    if (dErr || !dev) return res.status(404).json({ error: "Developer not found", detail: dErr?.message });

    let dailyStats;
    if (filterMethod) {
      // Door-specific path: query events directly, group by day. Sandbox
      // events excluded so the filtered view reflects production traffic only.
      dailyStats = await loadDailyByIntegrationMethod(sb, dev.id, filterMethod);
    } else {
      const r = await sb.from("daily_stats").select("*")
        .eq("developer_id", dev.id).order("date", { ascending: true }).limit(60);
      dailyStats = r.data || [];

      // Merge in live events from the last 7 days so brand-new publishers
      // see their first impressions immediately (not after the nightly
      // aggregate cron).
      dailyStats = await mergeLiveEvents(sb, dailyStats, { developerId: dev.id });
    }

    // Per-placement breakdown — pulls from the placement_daily_stats view
    // (created by migration 04). Joined with placements so we have surface
    // / format / status without a second round-trip.
    const placements = await loadPlacementBreakdown(sb, dev.id);

    // Per-integration-method breakdown — feeds the dashboard's "Your
    // integrations" cards. db/06_integration_method.sql tags each event
    // with mcp / js-snippet / npm-sdk / rest-api; sandbox traffic is
    // excluded so cards reflect real production usage. Always returns
    // the global breakdown regardless of the active filter (the cards
    // need to show all-door state even when the rest of the page is
    // filtered to one door).
    const by_integration_method = await loadIntegrationMethodBreakdown(sb, dev.id);

    const totals = rollUpDevTotals(dailyStats);

    // Real supply/fill from auction_logs: how many auctions this publisher's
    // inventory ran and how many filled (outcome='won'), sandbox excluded.
    // This is the honest, BBX-only fill picture — one demand source, no
    // external mediation. Null fill_rate when there's no traffic yet.
    const supply = await loadPublisherFill(sb, dev.id);

    return res.json({
      developer: formatDeveloper(dev),
      daily: dailyStats,
      totals,
      supply,
      placements,
      by_integration_method,
      filter_integration_method: filterMethod,
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

  // Demo per-integration-method breakdown — same shape as production.
  const by_integration_method = demoIntegrationMethodBreakdown(events, devKey);

  const totals = rollUpDevTotals(dailyStats);
  // Demo fill: derive from in-memory ledger auctions for this developer when
  // available; otherwise a clean "no traffic yet" shape. Same contract as prod.
  const supply = demoPublisherFill(devKey);
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
    supply,
    placements,
    by_integration_method,
    filter_integration_method: filterMethod,
  });
}

// ── Publisher supply / fill ───────────────────────────────────────────
// Honest BBX-only fill: count this publisher's auctions and how many filled
// (outcome='won') over the last 30 days, sandbox excluded. auction_logs is
// denormalized with publisher_id + an index on (publisher_id, ts), so these
// are two cheap head-count queries. Returns null fill_rate when there is no
// traffic yet (brand-new publisher) so the UI can show a clean empty state.
async function loadPublisherFill(sb, developerId) {
  const empty = { window_days: 30, auctions: 0, filled: 0, fill_rate: null };
  try {
    const sinceIso = new Date(Date.now() - 30 * 86400000).toISOString();
    const [{ count: auctions }, { count: won }] = await Promise.all([
      sb.from("auction_logs").select("*", { count: "exact", head: true })
        .eq("publisher_id", developerId).eq("is_sandbox", false).gte("ts", sinceIso),
      sb.from("auction_logs").select("*", { count: "exact", head: true })
        .eq("publisher_id", developerId).eq("is_sandbox", false)
        .eq("outcome", "won").gte("ts", sinceIso),
    ]);
    const a = auctions || 0, w = won || 0;
    return { window_days: 30, auctions: a, filled: w, fill_rate: a > 0 ? +(w / a).toFixed(4) : null };
  } catch (e) {
    console.error("[stats] loadPublisherFill failed:", e.message);
    return empty;
  }
}

// Demo equivalent — best-effort from the in-memory ledger. Never throws.
function demoPublisherFill(devKey) {
  const empty = { window_days: 30, auctions: 0, filled: 0, fill_rate: null };
  try {
    const led = demoLedger();
    const auctions = Array.isArray(led.auctions) ? led.auctions : [];
    const mine = auctions.filter(a => !devKey || a.publisher_id === devKey || a.developer_id === devKey);
    if (mine.length === 0) return empty;
    const won = mine.filter(a => a.outcome === "won" || a.won === true).length;
    return { window_days: 30, auctions: mine.length, filled: won, fill_rate: +(won / mine.length).toFixed(4) };
  } catch (_) { return empty; }
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

// ── Daily aggregation filtered by integration_method ────────────────────
// Used when the dashboard's filter dropdown is set to a specific door.
// Reads the events table directly (daily_stats lacks the column) and
// rolls up impressions / clicks / earnings per day for the last 60
// days. Sandbox events excluded; format matches what daily_stats
// returns so the rest of the dashboard pipeline doesn't branch.
async function loadDailyByIntegrationMethod(sb, developerId, integrationMethod) {
  try {
    const sinceISO = new Date(Date.now() - 60 * 86400000).toISOString();
    const { data: rows, error } = await sb.from("events")
      .select("event_type, cost, developer_payout, created_at")
      .eq("developer_id", developerId)
      .eq("integration_method", integrationMethod)
      .eq("is_sandbox", false)
      .gte("created_at", sinceISO);
    if (error || !rows) return [];

    const byDate = new Map();
    for (const r of rows) {
      const d = (r.created_at || "").slice(0, 10);
      if (!d) continue;
      if (!byDate.has(d)) {
        byDate.set(d, {
          date: d, developer_id: developerId,
          impressions: 0, clicks: 0,
          spend: 0, developer_earnings: 0,
        });
      }
      const b = byDate.get(d);
      if (r.event_type === "impression") b.impressions += 1;
      if (r.event_type === "click")      b.clicks      += 1;
      b.spend              += Number(r.cost || 0);
      b.developer_earnings += Number(r.developer_payout || 0);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  } catch (e) {
    console.error("[stats] loadDailyByIntegrationMethod:", e.message);
    return [];
  }
}

// ── Per-integration-method breakdown ────────────────────────────────────
// Aggregates the last 7 days of events tagged by integration_method
// (db/06_integration_method.sql). Powers the dashboard's "Your
// integrations" cards: one card per door, showing impressions / earnings
// for the doors the publisher has integrated with, "Not started" state
// for the ones they haven't. Sandbox events excluded — cards reflect
// real production usage only.
async function loadIntegrationMethodBreakdown(sb, developerId) {
  const empty = {
    "mcp":        { impressions: 0, clicks: 0, earnings: 0 },
    "js-snippet": { impressions: 0, clicks: 0, earnings: 0 },
    "npm-sdk":    { impressions: 0, clicks: 0, earnings: 0 },
    "rest-api":   { impressions: 0, clicks: 0, earnings: 0 },
  };
  try {
    const sinceISO = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: rows, error } = await sb.from("events")
      .select("integration_method, event_type, developer_payout")
      .eq("developer_id", developerId)
      .eq("is_sandbox", false)
      .gte("created_at", sinceISO);
    if (error || !rows) return empty;

    for (const r of rows) {
      const k = r.integration_method;
      if (!k || !empty[k]) continue;
      if (r.event_type === "impression") empty[k].impressions += 1;
      if (r.event_type === "click")      empty[k].clicks      += 1;
      empty[k].earnings += Number(r.developer_payout || 0);
    }
    // Round earnings to 4 dp to match developer_payout precision elsewhere.
    for (const k of Object.keys(empty)) {
      empty[k].earnings = +empty[k].earnings.toFixed(4);
    }
    return empty;
  } catch (e) {
    console.error("[stats] loadIntegrationMethodBreakdown:", e.message);
    return empty;
  }
}

// Demo equivalent — derive per-integration-method metrics from in-memory
// events. Used only when SUPABASE env is missing. Same shape as
// loadIntegrationMethodBreakdown so the frontend doesn't branch.
function demoIntegrationMethodBreakdown(events, devKey) {
  const empty = {
    "mcp":        { impressions: 0, clicks: 0, earnings: 0 },
    "js-snippet": { impressions: 0, clicks: 0, earnings: 0 },
    "npm-sdk":    { impressions: 0, clicks: 0, earnings: 0 },
    "rest-api":   { impressions: 0, clicks: 0, earnings: 0 },
  };
  for (const ev of events || []) {
    if (devKey && ev.developer_id !== devKey) continue;
    if (ev.is_sandbox) continue;
    const k = ev.integration_method;
    if (!k || !empty[k]) continue;
    if (ev.event_type === "impression") empty[k].impressions += 1;
    if (ev.event_type === "click")      empty[k].clicks      += 1;
    empty[k].earnings += Number(ev.developer_payout || 0);
  }
  for (const k of Object.keys(empty)) {
    empty[k].earnings = +empty[k].earnings.toFixed(4);
  }
  return empty;
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
// ── Reconciliation handler (Phase A — silent-failure observability) ─────
// Compares auction wins to impression events over the last 24h. The drop
// ratio surfaces silent write failures we'd otherwise never see, like the
// uuid type mismatch that dropped every sandbox impression for a week
// (caught by Door 4 / Telegram validation 2026-05-08).
//
// Cron schedule: daily at 02:00 UTC (vercel.json). Wanted every 6h but
// Vercel Hobby plan only allows daily — upgrade to Pro to tighten the loop.
//
// Returns:
//   {
//     window_hours: 24,
//     production: { auction_wins, impressions, ratio, alert: bool },
//     sandbox:    { auction_wins, impressions, ratio, alert: bool },
//     orphan_wins: [...]   -- top 10 winning auctions with no impression
//     thresholds: { ratio_floor: 0.5 }
//   }
//
// The alert flag fires when ratio < 0.5 AND there were >= 10 wins (low
// volume periods will naturally have noisy ratios).
//
// Call via: GET /api/stats?type=recon (cron) OR ?type=recon&debug=1 (manual)
async function handleRecon(req, res) {
  const sb = supa();
  if (!sb) {
    // Demo mode — no Supabase, no recon possible. Return a clear no-op
    // response so cron doesn't error.
    return res.status(200).json({
      mode: "demo",
      message: "Recon requires Supabase. Demo mode runs in-memory and resets per request.",
    });
  }

  const RATIO_FLOOR  = 0.5;
  const MIN_WINS_FOR_ALERT = 10;
  const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // ── Counts ──
  // Use { count: "exact", head: true } pattern so we don't pull rows.
  // Production wins are outcome='won'; sandbox traffic short-circuits the
  // real auction and gets outcome='sandbox' (mcp.js emitLog). Either way
  // an ad was served and an impression beacon SHOULD have followed.
  async function countAuctionsServed(isSandbox) {
    const wantedOutcome = isSandbox ? "sandbox" : "won";
    const { count, error } = await sb.from("auction_logs")
      .select("*", { count: "exact", head: true })
      .eq("outcome", wantedOutcome)
      .eq("is_sandbox", isSandbox)
      .gte("ts", sinceIso);
    if (error) console.error("bbx:recon:auctions_served_query_fail", error.message);
    return count || 0;
  }
  async function countImpressions(isSandbox) {
    const { count, error } = await sb.from("events")
      .select("*", { count: "exact", head: true })
      .eq("event_type", "impression")
      .eq("is_sandbox", isSandbox)
      .gte("created_at", sinceIso);
    if (error) console.error("bbx:recon:impressions_query_fail", error.message);
    return count || 0;
  }
  // Phase B (2026-05-11) — extend recon with click → conversion ratios so
  // ops can spot dropped conversion beacons the same way we spotted dropped
  // impression beacons. CVR is the more standard metric than impression→conv
  // (and lets us reuse the same alert-threshold logic).
  async function countByEventType(eventType, isSandbox) {
    const { count, error } = await sb.from("events")
      .select("*", { count: "exact", head: true })
      .eq("event_type", eventType)
      .eq("is_sandbox", isSandbox)
      .gte("created_at", sinceIso);
    if (error) console.error("bbx:recon:" + eventType + "_query_fail", error.message);
    return count || 0;
  }

  const [prodWins, prodImps, prodClicks, prodConvs,
         sbxWins,  sbxImps,  sbxClicks,  sbxConvs] = await Promise.all([
    countAuctionsServed(false),
    countImpressions(false),
    countByEventType("click",      false),
    countByEventType("conversion", false),
    countAuctionsServed(true),
    countImpressions(true),
    countByEventType("click",      true),
    countByEventType("conversion", true),
  ]);

  function summary(wins, imps, clicks, convs) {
    const ratio = wins > 0 ? +(imps / wins).toFixed(3) : null;
    const alert = wins >= MIN_WINS_FOR_ALERT && ratio !== null && ratio < RATIO_FLOOR;
    // CVR is conversions / clicks. We don't alert on absent CVR (most
    // sessions won't have any conversions yet) — but we publish the
    // ratio + counts so operators can spot a sudden zero-conversions
    // anomaly when conversions used to be flowing.
    const cvr = clicks > 0 ? +(convs / clicks).toFixed(3) : null;
    return {
      auction_wins: wins,
      impressions:  imps,
      clicks:       clicks,
      conversions:  convs,
      ratio,
      cvr,
      alert,
    };
  }
  const production = summary(prodWins, prodImps, prodClicks, prodConvs);
  const sandbox    = summary(sbxWins,  sbxImps,  sbxClicks,  sbxConvs);

  // ── Orphan wins — winning auctions with no impression event ──
  // Top 10 most recent. Useful for diagnosing the actual write_fail row
  // shape (campaign_id, integration_method) when an alert fires.
  let orphanWins = [];
  try {
    const { data: recentWins } = await sb.from("auction_logs")
      .select("auction_id, ts, integration_method, is_sandbox, winner_campaign_id, request")
      .in("outcome", ["won", "sandbox"])  // both real wins and sandbox short-circuits served ads
      .gte("ts", sinceIso)
      .order("ts", { ascending: false })
      .limit(50);
    if (Array.isArray(recentWins) && recentWins.length > 0) {
      const aucIds = recentWins.map((r) => r.auction_id);
      const { data: hits } = await sb.from("events")
        .select("auction_id")
        .eq("event_type", "impression")
        .in("auction_id", aucIds);
      const matched = new Set((hits || []).map((h) => h.auction_id));
      orphanWins = recentWins
        .filter((r) => !matched.has(r.auction_id))
        .slice(0, 10)
        .map((r) => ({
          auction_id:        r.auction_id,
          ts:                r.ts,
          integration_method: r.integration_method,
          is_sandbox:        r.is_sandbox,
          campaign_id:       r.winner_campaign_id,
          host_app:          r.request && r.request.host_app,
        }));
    }
  } catch (e) {
    console.error("bbx:recon:orphan_query_fail", e && e.message);
  }

  // ── Structured log so Vercel monitoring can pick up alerts ──
  // Same prefix shape as track.js write_fail. Anything an operator should
  // see surfaces under `bbx:recon:*` in logs.
  if (production.alert || sandbox.alert) {
    console.error("bbx:recon:alert", JSON.stringify({
      ts: new Date().toISOString(),
      tag: "recon.alert",
      production, sandbox,
      orphan_count: orphanWins.length,
      orphan_sample: orphanWins.slice(0, 3),
    }));
  } else {
    // Clean run — log at info level so operators can see the cron is alive.
    console.log("bbx:recon:ok", JSON.stringify({
      ts: new Date().toISOString(),
      tag: "recon.ok",
      production, sandbox,
    }));
  }

  // Phase E Day 2 — publisher balance health check. Flags any developer
  // whose (lifetime_earned − lifetime_paid) differs from balance by more
  // than 1%, surfacing accrual integrity drift (e.g., a credit RPC that
  // silently failed; a clawback that satisfied wrongly).
  //
  // The math:
  //   expected_balance = lifetime_earned − lifetime_paid − pending_clawbacks_remaining
  //   drift            = abs(balance − expected_balance)
  //   pct              = drift / max(balance, expected_balance)
  //   flag             = pct > 0.01 AND drift > $0.50
  //                      (cents-level drift is normal float rounding; we
  //                      only flag operationally-meaningful drift)
  let balanceHealth = { checked: 0, drifted: 0, drift_sample: [] };
  try {
    const { data: balances } = await sb.from("publisher_balance")
      .select("developer_id, balance, lifetime_earned, lifetime_paid")
      .gt("lifetime_earned", 0)        // ignore brand-new developers
      .limit(500);                     // cap so recon doesn't time out at scale
    if (Array.isArray(balances) && balances.length > 0) {
      const devIds = balances.map((b) => b.developer_id);
      // Pull pending clawbacks per developer in one query.
      const { data: pendingClaws } = await sb.from("payout_clawbacks")
        .select("developer_id, remaining_usd")
        .in("developer_id", devIds)
        .eq("status", "pending");
      const pendingByDev = new Map();
      for (const c of (pendingClaws || [])) {
        const cur = pendingByDev.get(c.developer_id) || 0;
        pendingByDev.set(c.developer_id, cur + (parseFloat(c.remaining_usd) || 0));
      }

      for (const b of balances) {
        balanceHealth.checked++;
        const balance        = parseFloat(b.balance) || 0;
        const lifetimeEarned = parseFloat(b.lifetime_earned) || 0;
        const lifetimePaid   = parseFloat(b.lifetime_paid) || 0;
        const pendingClaw    = pendingByDev.get(b.developer_id) || 0;
        const expected       = lifetimeEarned - lifetimePaid - pendingClaw;
        const drift          = Math.abs(balance - expected);
        const denom          = Math.max(Math.abs(balance), Math.abs(expected), 1);
        const pct            = drift / denom;
        if (pct > 0.01 && drift > 0.50) {
          balanceHealth.drifted++;
          if (balanceHealth.drift_sample.length < 5) {
            balanceHealth.drift_sample.push({
              developer_id:    b.developer_id,
              balance, lifetime_earned: lifetimeEarned,
              lifetime_paid:   lifetimePaid,
              pending_clawback_remaining: +pendingClaw.toFixed(2),
              expected_balance: +expected.toFixed(2),
              drift_usd:       +drift.toFixed(2),
              drift_pct:       +(pct * 100).toFixed(2),
            });
          }
        }
      }
    }
  } catch (e) {
    console.error("bbx:recon:balance_health_fail",
      JSON.stringify({ message: e && e.message }));
  }

  if (balanceHealth.drifted > 0) {
    console.error("bbx:recon:balance_drift", JSON.stringify({
      tag: "recon.balance_drift",
      drifted: balanceHealth.drifted,
      checked: balanceHealth.checked,
      sample:  balanceHealth.drift_sample,
    }));
  }

  // Phase E Day 4 — payout cron health summary. Surfaces the most recent
  // run's outcome plus aggregate counters so an operator can scan a
  // single recon endpoint and know whether anything needs attention.
  let payoutHealth = {
    last_run_at: null,
    last_run_status: null,            // 'paid' | 'pending' | 'failed' | null
    last_run_amount_usd: 0,
    pending_count: 0,
    failed_tier1_count: 0,
    failed_tier2_count: 0,
    blocked_publishers_count: 0,
    eligible_for_next_payout: 0,
  };
  try {
    // Most recent payout row
    const { data: lastRow } = await sb.from("payouts")
      .select("created_at, status, amount, completed_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastRow) {
      payoutHealth.last_run_at        = lastRow.completed_at || lastRow.created_at;
      payoutHealth.last_run_status    = lastRow.status;
      payoutHealth.last_run_amount_usd = parseFloat(lastRow.amount) || 0;
    }

    // Pending count
    const { count: pendingC } = await sb.from("payouts")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending");
    payoutHealth.pending_count = pendingC || 0;

    // Tier breakdown of failed
    const { count: t1 } = await sb.from("payouts")
      .select("*", { count: "exact", head: true })
      .eq("status", "failed").eq("failure_tier", 1);
    payoutHealth.failed_tier1_count = t1 || 0;
    const { count: t2 } = await sb.from("payouts")
      .select("*", { count: "exact", head: true })
      .eq("status", "failed").eq("failure_tier", 2);
    payoutHealth.failed_tier2_count = t2 || 0;

    // Blocked publishers
    const { count: blocked } = await sb.from("developers")
      .select("*", { count: "exact", head: true })
      .eq("payout_blocked", true);
    payoutHealth.blocked_publishers_count = blocked || 0;

    // Eligible-for-next-payout: payouts_enabled, !blocked, balance ≥ $25.
    // Two queries; supabase-js doesn't expose the join cleanly.
    const { data: eligibleDevs } = await sb.from("developers")
      .select("id")
      .eq("payouts_enabled", true)
      .eq("payout_blocked",  false)
      .not("stripe_account_id", "is", null);
    const eligibleIds = (eligibleDevs || []).map((d) => d.id);
    if (eligibleIds.length > 0) {
      const { count: ec } = await sb.from("publisher_balance")
        .select("*", { count: "exact", head: true })
        .in("developer_id", eligibleIds)
        .gte("balance", 25);
      payoutHealth.eligible_for_next_payout = ec || 0;
    }
  } catch (e) {
    console.error("bbx:recon:payout_health_fail",
      JSON.stringify({ message: e && e.message }));
  }

  return res.status(200).json({
    window_hours: 24,
    production, sandbox,
    orphan_wins: orphanWins,
    publisher_balance_health: balanceHealth,
    payout_cron_health: payoutHealth,
    thresholds: {
      ratio_floor:           RATIO_FLOOR,
      min_wins_for_alert:    MIN_WINS_FOR_ALERT,
      balance_drift_pct:     0.01,
      balance_drift_min_usd: 0.50,
    },
    generated_at: new Date().toISOString(),
  });
}

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

// ═══════════════════════════════════════════════════════════════════════
// Phase H Panel 1 — Live Activity ("hospital monitor")
// ═══════════════════════════════════════════════════════════════════════
// One round-trip view of the system's current heartbeat. Designed so the
// operator's question — "is the machine healthy?" — gets answered in
// under 10 seconds at a glance.
//
// Auth: Authorization: Bearer ${ADMIN_TOKEN}
//   • Same scheme as billing admin actions (api/billing.js).
//   • Demo mode (no Supabase) skips auth so tests can exercise the path.
//
// Query params:
//   • mode = production | sandbox  (default: production)
//        Lets the operator flip between live traffic and their sandbox
//        validation traffic without rebuilding the URL each time.
//
// Returned shape: see launch-kit/phase-h-panel-1-live-activity-plan.md §
// "Data source plan" — kept stable so the UI can rev independently.

function _liveActivityAdminAuth(req) {
  if (!HAS_SUPABASE) return true;
  // Accept either env name so the admin console only needs one secret
  // configured (ADMIN_TOKEN and BBX_ADMIN_KEY are treated as equivalent
  // across api/stats, api/billing and api/campaigns).
  const keys = [process.env.ADMIN_TOKEN, process.env.BBX_ADMIN_KEY].filter(Boolean);
  if (keys.length === 0) return false;
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  return keys.some((k) => auth === `Bearer ${k}`);
}

async function handleLiveActivity(req, res) {
  if (!_liveActivityAdminAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  const mode = (req.query && req.query.mode === "sandbox") ? "sandbox" : "production";
  const isSandbox = mode === "sandbox";

  const sb = supa();
  if (!sb) {
    // Demo mode — return a zeroed-out but well-shaped payload. Lets the
    // UI test render without crashing while we're offline.
    return res.status(200).json({
      mode, generated_at: new Date().toISOString(), demo: true,
      health: { status: "healthy", fill_rate_24h: null, tier2_24h: 0, tier3_alerts_24h: 0, blocked_publishers: 0 },
      volume: { auctions_5m: 0, auctions_1h: 0, auctions_24h: 0, trend_pct: 0 },
      money:  { advertiser_spend_24h: 0, bb_revenue_24h: 0, publisher_accrued_24h: 0 },
      top_publishers: [], top_campaigns: [],
      by_door: [
        { door: "mcp",        auctions_24h: 0, impressions_24h: 0, active_publishers: 0, avg_ecpm: null, fill_rate: null },
        { door: "js-snippet", auctions_24h: 0, impressions_24h: 0, active_publishers: 0, avg_ecpm: null, fill_rate: null },
        { door: "npm-sdk",    auctions_24h: 0, impressions_24h: 0, active_publishers: 0, avg_ecpm: null, fill_rate: null },
        { door: "rest-api",   auctions_24h: 0, impressions_24h: 0, active_publishers: 0, avg_ecpm: null, fill_rate: null },
      ],
      door_timeseries: [],
      recent_alerts: [],
    });
  }

  const now = Date.now();
  const since5m  = new Date(now -      5 * 60 * 1000).toISOString();
  const since1h  = new Date(now -     60 * 60 * 1000).toISOString();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  // Helper — count rows matching a window. Uses HEAD to avoid pulling rows.
  async function countAuctions(sinceIso, outcome = null) {
    let q = sb.from("auction_logs").select("*", { count: "exact", head: true })
      .eq("is_sandbox", isSandbox).gte("ts", sinceIso);
    if (outcome) q = q.eq("outcome", outcome);
    const { count } = await q;
    return count || 0;
  }

  // ── 1. Volume: auctions in last 5m / 1h / 24h ──
  const [auctions_5m, auctions_1h, auctions_24h, wins_24h] = await Promise.all([
    countAuctions(since5m),
    countAuctions(since1h),
    countAuctions(since24h),
    countAuctions(since24h, "won"),
  ]);

  // 1h auctions vs trailing-24h hourly average → trend %.
  const trailing24hAvgPerHour = auctions_24h / 24;
  const trend_pct = trailing24hAvgPerHour > 0
    ? +(((auctions_1h - trailing24hAvgPerHour) / trailing24hAvgPerHour) * 100).toFixed(1)
    : 0;

  // ── 2. Health: fill rate + payout failures + blocked publishers ──
  const totalNonSandbox = isSandbox ? auctions_24h : auctions_24h; // both modes use is_sandbox filter
  const fill_rate_24h = totalNonSandbox > 0 ? +(wins_24h / totalNonSandbox).toFixed(3) : null;

  async function countPayouts(failureTier) {
    const { count } = await sb.from("payouts")
      .select("*", { count: "exact", head: true })
      .eq("failure_tier", failureTier).gte("created_at", since24h);
    return count || 0;
  }
  // Tier-3 is an "alert" rather than a payout-row attribute — we surface
  // recent payout rows with failure_tier=3 to drive both the count and
  // the recent_alerts feed below. Same query, two consumers.
  async function recentTier3Failures() {
    const { data } = await sb.from("payouts")
      .select("id, developer_id, failure_reason, created_at")
      .eq("failure_tier", 3).gte("created_at", since24h)
      .order("created_at", { ascending: false }).limit(10);
    return data || [];
  }
  // blocked_publishers — count of developers in 'blocked' status.
  async function countBlockedPublishers() {
    const { count } = await sb.from("developers")
      .select("*", { count: "exact", head: true }).eq("status", "blocked");
    return count || 0;
  }

  const [tier2_24h, tier3Failures, blocked_publishers] = await Promise.all([
    countPayouts(2).catch(() => 0),
    recentTier3Failures().catch(() => []),
    countBlockedPublishers().catch(() => 0),
  ]);
  const tier3_24h = tier3Failures.length;

  // Status calc per design doc Q1 (defaults).
  let status = "healthy";
  if (
    (fill_rate_24h !== null && fill_rate_24h < 0.30) ||
    tier3_24h > 0 ||
    blocked_publishers >= 5
  ) status = "action_required";
  else if (
    (fill_rate_24h !== null && fill_rate_24h < 0.60) ||
    tier2_24h > 0 ||
    blocked_publishers > 0
  ) status = "watch";

  // ── 3. Money: spend / BB take / publisher accrual ──
  // Sum events.cost (advertiser cost) and events.developer_payout (publisher accrual).
  // We pull aggregated sums via a single SELECT with sum() — Supabase
  // doesn't expose sum() through PostgREST in a clean way, so we use
  // a tiny RPC-style read pulling cost + developer_payout in batches.
  let advertiser_spend_24h = 0, publisher_accrued_24h = 0;
  {
    const PAGE = 1000;
    let offset = 0;
    for (let i = 0; i < 50; i++) { // hard cap at 50k events / call
      const { data, error } = await sb.from("events")
        .select("cost, developer_payout")
        .eq("is_sandbox", isSandbox).gte("created_at", since24h)
        .range(offset, offset + PAGE - 1);
      if (error || !data || data.length === 0) break;
      for (const e of data) {
        advertiser_spend_24h += Number(e.cost) || 0;
        publisher_accrued_24h += Number(e.developer_payout) || 0;
      }
      if (data.length < PAGE) break;
      offset += PAGE;
    }
  }
  const bb_revenue_24h = +(advertiser_spend_24h - publisher_accrued_24h).toFixed(4);
  advertiser_spend_24h  = +advertiser_spend_24h.toFixed(4);
  publisher_accrued_24h = +publisher_accrued_24h.toFixed(4);

  // ── 4. Top publishers (24h, by impressions) ──
  // Aggregate impressions + earnings by developer_id, join email/app_name.
  async function loadTopPublishers() {
    const { data: events } = await sb.from("events")
      .select("developer_id, event_type, developer_payout")
      .eq("is_sandbox", isSandbox).gte("created_at", since24h)
      .not("developer_id", "is", null);
    if (!events || events.length === 0) return [];

    const agg = new Map();
    for (const e of events) {
      if (!e.developer_id) continue;
      const a = agg.get(e.developer_id) || { developer_id: e.developer_id, impressions_24h: 0, earnings_24h: 0 };
      if (e.event_type === "impression") a.impressions_24h += 1;
      a.earnings_24h += Number(e.developer_payout) || 0;
      agg.set(e.developer_id, a);
    }
    const top = [...agg.values()].sort((x, y) => y.impressions_24h - x.impressions_24h).slice(0, 5);
    if (top.length === 0) return [];

    // Backfill email + app_name.
    const ids = top.map((r) => r.developer_id);
    const { data: devs } = await sb.from("developers")
      .select("id, email, app_name").in("id", ids);
    const byId = new Map((devs || []).map((d) => [d.id, d]));
    return top.map((r) => ({
      ...r,
      earnings_24h: +r.earnings_24h.toFixed(4),
      email: (byId.get(r.developer_id) || {}).email || null,
      app_name: (byId.get(r.developer_id) || {}).app_name || null,
    }));
  }

  // ── 5. Top campaigns (24h, by impressions) ──
  async function loadTopCampaigns() {
    const { data: events } = await sb.from("events")
      .select("campaign_id, event_type, cost")
      .eq("is_sandbox", isSandbox).gte("created_at", since24h)
      .not("campaign_id", "is", null);
    if (!events || events.length === 0) return [];

    const agg = new Map();
    for (const e of events) {
      if (!e.campaign_id) continue;
      const a = agg.get(e.campaign_id) || { campaign_id: e.campaign_id, impressions_24h: 0, spend_24h: 0 };
      if (e.event_type === "impression") a.impressions_24h += 1;
      a.spend_24h += Number(e.cost) || 0;
      agg.set(e.campaign_id, a);
    }
    const top = [...agg.values()].sort((x, y) => y.impressions_24h - x.impressions_24h).slice(0, 5);
    if (top.length === 0) return [];
    const ids = top.map((r) => r.campaign_id);
    const { data: campaigns } = await sb.from("campaigns")
      .select("id, name, advertiser_id").in("id", ids);
    const advIds = [...new Set((campaigns || []).map((c) => c.advertiser_id).filter(Boolean))];
    const { data: advertisers } = advIds.length
      ? await sb.from("advertisers").select("id, email, company_name").in("id", advIds)
      : { data: [] };
    const advById  = new Map((advertisers || []).map((a) => [a.id, a]));
    const campById = new Map((campaigns || []).map((c) => [c.id, c]));
    return top.map((r) => {
      const c = campById.get(r.campaign_id) || {};
      const a = advById.get(c.advertiser_id) || {};
      return {
        ...r,
        spend_24h: +r.spend_24h.toFixed(4),
        name: c.name || null,
        advertiser_email: a.email || null,
        advertiser_company: a.company_name || null,
      };
    });
  }

  // ── 6. By-door breakdown ──
  // auction_logs.integration_method drives this. Some rows pre-date
  // migration 06 and have null integration_method; we bucket those into
  // 'unknown' but only return the 4 production doors in the response.
  // Returns { by_door, door_timeseries }.
  //   by_door         — per-door 24h aggregate (auctions, impressions,
  //                     eCPM, fill rate, AND distinct active publishers).
  //   door_timeseries — 24 hourly buckets, each with per-door auction
  //                     counts, for the distribution-over-time view.
  // Both are built from a single pass over auction_logs + events, so
  // adding the publisher set + hourly bucketing costs no extra queries.
  async function loadByDoor() {
    const DOOR_KEYS = ["mcp", "js-snippet", "npm-sdk", "rest-api"];
    const buckets = {};
    for (const d of DOOR_KEYS) {
      buckets[d] = {
        auctions_24h: 0, won_24h: 0, spend_24h: 0, impressions_24h: 0,
        // Distinct publisher_ids seen on this door in the window.
        publishers: new Set(),
      };
    }

    // Hourly time-series — 24 buckets oldest→newest. Pre-seeded so empty
    // hours still render (a flat-line gap is itself signal). Keyed by the
    // ISO hour prefix ("2026-05-20T14") for O(1) lookup while paging.
    const nowMs = Date.now();
    const hourBuckets = [];
    const hourIndex = {};
    for (let h = 23; h >= 0; h--) {
      const dt = new Date(nowMs - h * 3600 * 1000);
      const key = dt.toISOString().slice(0, 13);
      const bucket = { hour: key + ":00:00Z", mcp: 0, "js-snippet": 0, "npm-sdk": 0, "rest-api": 0 };
      hourBuckets.push(bucket);
      hourIndex[key] = bucket;
    }

    // auctions per door (paged) — also feeds the publisher set + the
    // hourly time-series in the same loop.
    {
      const PAGE = 1000;
      let offset = 0;
      for (let i = 0; i < 50; i++) {
        const { data, error } = await sb.from("auction_logs")
          .select("integration_method, outcome, publisher_id, ts")
          .eq("is_sandbox", isSandbox).gte("ts", since24h)
          .range(offset, offset + PAGE - 1);
        if (error || !data || data.length === 0) break;
        for (const a of data) {
          const door = (a.integration_method || "").toLowerCase();
          const b = buckets[door];
          if (!b) continue;
          b.auctions_24h += 1;
          if (a.outcome === "won") b.won_24h += 1;
          if (a.publisher_id) b.publishers.add(a.publisher_id);
          if (a.ts) {
            const hb = hourIndex[String(a.ts).slice(0, 13)];
            if (hb) hb[door] += 1;
          }
        }
        if (data.length < PAGE) break;
        offset += PAGE;
      }
    }
    // events per door — impressions & spend
    {
      const PAGE = 1000;
      let offset = 0;
      for (let i = 0; i < 50; i++) {
        const { data, error } = await sb.from("events")
          .select("integration_method, event_type, cost")
          .eq("is_sandbox", isSandbox).gte("created_at", since24h)
          .range(offset, offset + PAGE - 1);
        if (error || !data || data.length === 0) break;
        for (const e of data) {
          const door = (e.integration_method || "").toLowerCase();
          const b = buckets[door];
          if (!b) continue;
          if (e.event_type === "impression") b.impressions_24h += 1;
          b.spend_24h += Number(e.cost) || 0;
        }
        if (data.length < PAGE) break;
        offset += PAGE;
      }
    }

    const by_door = Object.entries(buckets).map(([door, b]) => ({
      door,
      auctions_24h:    b.auctions_24h,
      impressions_24h: b.impressions_24h,
      // Distinct publishers serving this door in the last 24h — adoption
      // signal: "how many publishers actually run Lumi on this door."
      active_publishers: b.publishers.size,
      // eCPM = spend / impressions * 1000
      avg_ecpm: b.impressions_24h > 0 ? +((b.spend_24h / b.impressions_24h) * 1000).toFixed(2) : null,
      // Fill rate at the door level uses won/auctions of that door.
      fill_rate: b.auctions_24h > 0 ? +(b.won_24h / b.auctions_24h).toFixed(3) : null,
    }));
    return { by_door, door_timeseries: hourBuckets };
  }

  // ── 7. Recent alerts feed ──
  // Tier-2 + Tier-3 payout failures, fill-rate dips, blocked-publisher
  // counts. Capped at 10 most-recent. Each carries a deep link the UI
  // wires to a switchPanel call.
  async function loadRecentAlerts() {
    const out = [];
    // Tier-3 (already loaded above)
    for (const t3 of tier3Failures.slice(0, 5)) {
      out.push({
        ts: t3.created_at,
        tag: "payout.tier3",
        message: "Tier-3 payout failure" + (t3.failure_reason ? ` — ${t3.failure_reason}` : ""),
        link: "payouts",
      });
    }
    // Recent Tier-2 (separate query, capped)
    const { data: t2 } = await sb.from("payouts")
      .select("id, developer_id, failure_reason, created_at")
      .eq("failure_tier", 2).gte("created_at", since24h)
      .order("created_at", { ascending: false }).limit(5);
    for (const r of (t2 || [])) {
      out.push({
        ts: r.created_at,
        tag: "payout.tier2",
        message: "Tier-2 payout failure" + (r.failure_reason ? ` — ${r.failure_reason}` : ""),
        link: "payouts",
      });
    }
    // Fill-rate dip alert (derived; not stored)
    if (fill_rate_24h !== null && fill_rate_24h < 0.30) {
      out.push({
        ts: new Date().toISOString(),
        tag: "fill.dip",
        message: `Fill rate ${(fill_rate_24h * 100).toFixed(0)}% (24h) — below 30% floor`,
        link: "campaigns",
      });
    }
    return out.sort((a, b) => (b.ts || "").localeCompare(a.ts || "")).slice(0, 10);
  }

  const [top_publishers, top_campaigns, doorData, recent_alerts] = await Promise.all([
    loadTopPublishers().catch(() => []),
    loadTopCampaigns().catch(() => []),
    loadByDoor().catch(() => ({ by_door: [], door_timeseries: [] })),
    loadRecentAlerts().catch(() => []),
  ]);

  return res.status(200).json({
    mode,
    generated_at: new Date().toISOString(),
    health: {
      status,
      fill_rate_24h,
      tier2_24h,
      tier3_alerts_24h: tier3_24h,
      blocked_publishers,
    },
    volume: { auctions_5m, auctions_1h, auctions_24h, trend_pct },
    money: { advertiser_spend_24h, bb_revenue_24h, publisher_accrued_24h },
    top_publishers,
    top_campaigns,
    by_door: doorData.by_door,
    door_timeseries: doorData.door_timeseries,
    recent_alerts,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Phase H Panel 2 — Money Flow
// ═══════════════════════════════════════════════════════════════════════
// Full financial picture in one round-trip. Where Panel 1 answers
// "is the machine healthy?", Panel 2 answers "is the money moving
// correctly?" — across three time windows (24h / 7d / 30d) so the
// operator can spot trends, not just instantaneous state.
//
// Shape:
//   {
//     mode, generated_at,
//     windows: {
//       "24h": { advertiser_spend, bb_revenue, publisher_accrued, payouts_paid },
//       "7d":  { ... },
//       "30d": { ... },
//     },
//     advertiser_deposits_24h, advertiser_deposits_7d, advertiser_deposits_30d,
//     top_advertisers_by_spend_24h: [{ id, company_name, email, spend }],
//     top_publishers_by_balance:    [{ developer_id, email, balance, lifetime_earned, lifetime_paid }],
//     pending_clawbacks_total,
//     payout_health: { ...payout_cron_health from recon },
//     balance_drift: { checked, drifted, sample[] },          // from recon
//     eligible_for_next_payout: { count, total_usd_ready },
//     stripe_balance_available_usd,                            // for "can cron pay?" check
//   }

async function handleMoneyFlow(req, res) {
  if (!_liveActivityAdminAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  const mode = (req.query && req.query.mode === "sandbox") ? "sandbox" : "production";
  const isSandbox = mode === "sandbox";

  const sb = supa();
  if (!sb) {
    return res.status(200).json({
      mode, demo: true, generated_at: new Date().toISOString(),
      windows: {
        "24h": { advertiser_spend: 0, bb_revenue: 0, publisher_accrued: 0, payouts_paid: 0 },
        "7d":  { advertiser_spend: 0, bb_revenue: 0, publisher_accrued: 0, payouts_paid: 0 },
        "30d": { advertiser_spend: 0, bb_revenue: 0, publisher_accrued: 0, payouts_paid: 0 },
      },
      by_door: [
        { door: "mcp",        advertiser_spend: 0, publisher_accrued: 0, bb_revenue: 0, impressions: 0 },
        { door: "js-snippet", advertiser_spend: 0, publisher_accrued: 0, bb_revenue: 0, impressions: 0 },
        { door: "npm-sdk",    advertiser_spend: 0, publisher_accrued: 0, bb_revenue: 0, impressions: 0 },
        { door: "rest-api",   advertiser_spend: 0, publisher_accrued: 0, bb_revenue: 0, impressions: 0 },
      ],
      advertiser_deposits_24h: 0, advertiser_deposits_7d: 0, advertiser_deposits_30d: 0,
      top_advertisers_by_spend_24h: [],
      top_publishers_by_balance: [],
      pending_clawbacks_total: 0,
      payout_health: null,
      balance_drift: { checked: 0, drifted: 0, sample: [] },
      eligible_for_next_payout: { count: 0, total_usd_ready: 0 },
      stripe_balance_available_usd: null,
    });
  }

  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since7d  = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Paged read of events.cost + developer_payout for one time window.
  async function sumEvents(sinceIso) {
    let spend = 0, accrued = 0, rows = 0;
    const PAGE = 1000;
    let offset = 0;
    for (let i = 0; i < 60; i++) { // hard cap at 60k events / call
      const { data, error } = await sb.from("events")
        .select("cost, developer_payout")
        .eq("is_sandbox", isSandbox).gte("created_at", sinceIso)
        .range(offset, offset + PAGE - 1);
      if (error || !data || data.length === 0) break;
      for (const e of data) {
        spend  += Number(e.cost) || 0;
        accrued += Number(e.developer_payout) || 0;
      }
      rows += data.length;
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    return { spend: +spend.toFixed(4), accrued: +accrued.toFixed(4), rows };
  }
  async function sumPayouts(sinceIso) {
    let paid = 0;
    const { data } = await sb.from("payouts")
      .select("amount, status, completed_at, created_at")
      .eq("status", "paid")
      .gte("completed_at", sinceIso);
    for (const p of (data || [])) paid += Number(p.amount) || 0;
    return +paid.toFixed(2);
  }
  async function sumDeposits(sinceIso) {
    // Advertiser deposits come from transactions table where type=deposit.
    const { data } = await sb.from("transactions")
      .select("amount, type, status, created_at")
      .eq("type", "deposit").eq("status", "completed")
      .gte("created_at", sinceIso);
    let dep = 0;
    for (const t of (data || [])) dep += Number(t.amount) || 0;
    return +dep.toFixed(2);
  }

  const [w24, w7, w30, p24, p7, p30, d24, d7, d30] = await Promise.all([
    sumEvents(since24h).catch(() => ({ spend: 0, accrued: 0 })),
    sumEvents(since7d ).catch(() => ({ spend: 0, accrued: 0 })),
    sumEvents(since30d).catch(() => ({ spend: 0, accrued: 0 })),
    sumPayouts(since24h).catch(() => 0),
    sumPayouts(since7d ).catch(() => 0),
    sumPayouts(since30d).catch(() => 0),
    sumDeposits(since24h).catch(() => 0),
    sumDeposits(since7d ).catch(() => 0),
    sumDeposits(since30d).catch(() => 0),
  ]);

  const windowsOut = {
    "24h": { advertiser_spend: w24.spend, bb_revenue: +(w24.spend - w24.accrued).toFixed(4), publisher_accrued: w24.accrued, payouts_paid: p24 },
    "7d":  { advertiser_spend: w7.spend,  bb_revenue: +(w7.spend  - w7.accrued ).toFixed(4), publisher_accrued: w7.accrued,  payouts_paid: p7  },
    "30d": { advertiser_spend: w30.spend, bb_revenue: +(w30.spend - w30.accrued).toFixed(4), publisher_accrued: w30.accrued, payouts_paid: p30 },
  };

  // Top advertisers by 24h spend.
  async function loadTopAdvertisersBySpend() {
    const { data: campaigns } = await sb.from("campaigns").select("id, advertiser_id");
    const campToAdv = new Map((campaigns || []).map((c) => [c.id, c.advertiser_id]));
    // Aggregate events.cost by advertiser_id over 24h.
    const PAGE = 1000;
    let offset = 0;
    const totals = new Map(); // advertiser_id → spend
    for (let i = 0; i < 60; i++) {
      const { data, error } = await sb.from("events")
        .select("campaign_id, cost").eq("is_sandbox", isSandbox).gte("created_at", since24h)
        .not("campaign_id", "is", null)
        .range(offset, offset + PAGE - 1);
      if (error || !data || data.length === 0) break;
      for (const e of data) {
        const adv = campToAdv.get(e.campaign_id);
        if (!adv) continue;
        totals.set(adv, (totals.get(adv) || 0) + (Number(e.cost) || 0));
      }
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    const top = [...totals.entries()]
      .map(([id, spend]) => ({ id, spend: +spend.toFixed(4) }))
      .sort((a, b) => b.spend - a.spend).slice(0, 5);
    if (top.length === 0) return [];
    const { data: advs } = await sb.from("advertisers")
      .select("id, email, company_name, balance")
      .in("id", top.map((t) => t.id));
    const byId = new Map((advs || []).map((a) => [a.id, a]));
    return top.map((t) => ({
      ...t,
      email: (byId.get(t.id) || {}).email || null,
      company_name: (byId.get(t.id) || {}).company_name || null,
      balance: Number((byId.get(t.id) || {}).balance) || 0,
    }));
  }

  // Top publishers by current balance.
  async function loadTopPublishersByBalance() {
    const { data: balances } = await sb.from("publisher_balance")
      .select("developer_id, balance, lifetime_earned, lifetime_paid")
      .order("balance", { ascending: false }).limit(10);
    if (!balances || balances.length === 0) return [];
    const ids = balances.map((b) => b.developer_id);
    const { data: devs } = await sb.from("developers")
      .select("id, email, app_name").in("id", ids);
    const byId = new Map((devs || []).map((d) => [d.id, d]));
    return balances.map((b) => ({
      developer_id: b.developer_id,
      email:        (byId.get(b.developer_id) || {}).email || null,
      app_name:     (byId.get(b.developer_id) || {}).app_name || null,
      balance:         +Number(b.balance         || 0).toFixed(2),
      lifetime_earned: +Number(b.lifetime_earned || 0).toFixed(2),
      lifetime_paid:   +Number(b.lifetime_paid   || 0).toFixed(2),
    })).slice(0, 5);
  }

  // Pending clawbacks total.
  async function sumPendingClawbacks() {
    const { data } = await sb.from("payout_clawbacks")
      .select("remaining_usd").eq("status", "pending");
    let s = 0;
    for (const c of (data || [])) s += Number(c.remaining_usd) || 0;
    return +s.toFixed(2);
  }

  // Eligible-for-next-payout: developers w/ payouts enabled, not blocked,
  // stripe account set, balance ≥ $25. Returns {count, total_usd_ready}.
  async function loadEligibleForNextPayout() {
    const { data: devs } = await sb.from("developers")
      .select("id").eq("payouts_enabled", true).eq("payout_blocked", false)
      .not("stripe_account_id", "is", null);
    const ids = (devs || []).map((d) => d.id);
    if (ids.length === 0) return { count: 0, total_usd_ready: 0 };
    const { data: balances } = await sb.from("publisher_balance")
      .select("developer_id, balance").in("developer_id", ids).gte("balance", 25);
    let total = 0;
    for (const b of (balances || [])) total += Number(b.balance) || 0;
    return { count: (balances || []).length, total_usd_ready: +total.toFixed(2) };
  }

  // Per-door money breakdown (24h) — answers "which door earns?".
  // Aggregates events.cost + developer_payout grouped by integration_method.
  // bb_revenue per door = spend − publisher_accrued for that door.
  async function loadMoneyByDoor() {
    const DOOR_KEYS = ["mcp", "js-snippet", "npm-sdk", "rest-api"];
    const buckets = {};
    for (const d of DOOR_KEYS) buckets[d] = { advertiser_spend: 0, publisher_accrued: 0, impressions: 0 };
    const PAGE = 1000;
    let offset = 0;
    for (let i = 0; i < 60; i++) {
      const { data, error } = await sb.from("events")
        .select("integration_method, event_type, cost, developer_payout")
        .eq("is_sandbox", isSandbox).gte("created_at", since24h)
        .range(offset, offset + PAGE - 1);
      if (error || !data || data.length === 0) break;
      for (const e of data) {
        const door = (e.integration_method || "").toLowerCase();
        const b = buckets[door];
        if (!b) continue;
        b.advertiser_spend  += Number(e.cost) || 0;
        b.publisher_accrued += Number(e.developer_payout) || 0;
        if (e.event_type === "impression") b.impressions += 1;
      }
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    return DOOR_KEYS.map((door) => {
      const b = buckets[door];
      return {
        door,
        advertiser_spend:  +b.advertiser_spend.toFixed(4),
        publisher_accrued: +b.publisher_accrued.toFixed(4),
        bb_revenue:        +(b.advertiser_spend - b.publisher_accrued).toFixed(4),
        impressions:       b.impressions,
      };
    });
  }

  // Stripe available balance (so we can warn the operator if cron would
  // fail for "insufficient platform balance"). Best-effort; never blocks
  // the response. Cached for 60s to avoid hammering the Stripe API.
  let stripeBalanceUsd = null;
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      stripeBalanceUsd = await _cachedStripeBalance(60_000);
    } catch (e) {
      console.error("bbx:money_flow:stripe_balance_fail", e && e.message);
    }
  }

  // Reuse the heavier-lift recon pieces directly (cheaper than re-running
  // their query mass; we already pay for them via the cron call). For
  // now we re-do them inline so this endpoint is callable on its own.
  const payoutHealth = await _loadPayoutHealthInline(sb).catch(() => null);
  const balanceDrift = await _loadBalanceDriftInline(sb).catch(() => ({ checked: 0, drifted: 0, sample: [] }));

  const [top_advertisers_by_spend_24h, top_publishers_by_balance, pending_clawbacks_total, eligible_for_next_payout, by_door] =
    await Promise.all([
      loadTopAdvertisersBySpend().catch(() => []),
      loadTopPublishersByBalance().catch(() => []),
      sumPendingClawbacks().catch(() => 0),
      loadEligibleForNextPayout().catch(() => ({ count: 0, total_usd_ready: 0 })),
      loadMoneyByDoor().catch(() => []),
    ]);

  return res.status(200).json({
    mode,
    generated_at: new Date().toISOString(),
    windows: windowsOut,
    by_door,
    advertiser_deposits_24h: d24,
    advertiser_deposits_7d:  d7,
    advertiser_deposits_30d: d30,
    top_advertisers_by_spend_24h,
    top_publishers_by_balance,
    pending_clawbacks_total,
    payout_health: payoutHealth,
    balance_drift: balanceDrift,
    eligible_for_next_payout,
    stripe_balance_available_usd: stripeBalanceUsd,
  });
}

// Stripe balance — cached so concurrent admin tabs don't hammer the API.
let _stripeBalanceCache = { until: 0, value: null };
async function _cachedStripeBalance(ttlMs) {
  const now = Date.now();
  if (_stripeBalanceCache.until > now) return _stripeBalanceCache.value;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  // Tiny REST call instead of pulling the full stripe SDK just for one
  // balance retrieve. Bonus: matches the lightweight pattern we use in
  // api/billing.js for currency detection.
  const r = await fetch("https://api.stripe.com/v1/balance", {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  // available[0].amount is in cents.
  const usd = j && j.available && j.available[0] ? j.available[0].amount / 100 : null;
  _stripeBalanceCache = { until: now + ttlMs, value: usd };
  return usd;
}

// Inline payout-health summary (mirrors recon's payout_cron_health).
async function _loadPayoutHealthInline(sb) {
  const out = {
    last_run_at: null, last_run_status: null, last_run_amount_usd: 0,
    pending_count: 0, failed_tier1_count: 0, failed_tier2_count: 0,
    blocked_publishers_count: 0,
  };
  const { data: lastRow } = await sb.from("payouts")
    .select("created_at, status, amount, completed_at")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (lastRow) {
    out.last_run_at         = lastRow.completed_at || lastRow.created_at;
    out.last_run_status     = lastRow.status;
    out.last_run_amount_usd = Number(lastRow.amount) || 0;
  }
  const { count: pendingC } = await sb.from("payouts").select("*", { count: "exact", head: true }).eq("status", "pending");
  out.pending_count = pendingC || 0;
  const { count: t1 } = await sb.from("payouts").select("*", { count: "exact", head: true }).eq("status", "failed").eq("failure_tier", 1);
  out.failed_tier1_count = t1 || 0;
  const { count: t2 } = await sb.from("payouts").select("*", { count: "exact", head: true }).eq("status", "failed").eq("failure_tier", 2);
  out.failed_tier2_count = t2 || 0;
  const { count: blocked } = await sb.from("developers").select("*", { count: "exact", head: true }).eq("payout_blocked", true);
  out.blocked_publishers_count = blocked || 0;
  return out;
}

// Inline balance-drift summary (mirrors recon's publisher_balance_health).
async function _loadBalanceDriftInline(sb) {
  const out = { checked: 0, drifted: 0, sample: [] };
  const { data: balances } = await sb.from("publisher_balance")
    .select("developer_id, balance, lifetime_earned, lifetime_paid");
  if (!balances || balances.length === 0) return out;
  const devIds = balances.map((b) => b.developer_id);
  const { data: pendingClaws } = await sb.from("payout_clawbacks")
    .select("developer_id, remaining_usd").in("developer_id", devIds).eq("status", "pending");
  const pendingByDev = new Map();
  for (const c of (pendingClaws || [])) {
    pendingByDev.set(c.developer_id, (pendingByDev.get(c.developer_id) || 0) + (Number(c.remaining_usd) || 0));
  }
  for (const b of balances) {
    out.checked++;
    const balance        = Number(b.balance) || 0;
    const lifetimeEarned = Number(b.lifetime_earned) || 0;
    const lifetimePaid   = Number(b.lifetime_paid) || 0;
    const pendingClaw    = pendingByDev.get(b.developer_id) || 0;
    const expected       = lifetimeEarned - lifetimePaid - pendingClaw;
    const drift          = Math.abs(balance - expected);
    const denom          = Math.max(Math.abs(balance), Math.abs(expected), 1);
    const pct            = drift / denom;
    if (pct > 0.01 && drift > 0.50) {
      out.drifted++;
      if (out.sample.length < 5) {
        out.sample.push({
          developer_id: b.developer_id,
          balance, lifetime_earned: lifetimeEarned, lifetime_paid: lifetimePaid,
          pending_clawback_remaining: +pendingClaw.toFixed(2),
          expected_balance: +expected.toFixed(2),
          drift_usd: +drift.toFixed(2),
          drift_pct: +(pct * 100).toFixed(2),
        });
      }
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// Phase H Panel 3 — Auction Inspector
// ═══════════════════════════════════════════════════════════════════════
// Lets the operator answer "why didn't my campaign serve here?" from the
// admin UI. Two modes:
//   • list:   ?type=auction_inspect&limit=N&outcome=X&publisher_id=Y&since=ISO
//             Returns N most-recent auction_logs summaries.
//   • detail: ?type=auction_inspect&id=AUCTION_ID
//             Returns the full row including the candidates array.
//
// Why this matters: today the only way to debug an auction is `select *
// from auction_logs where auction_id = '...'` in Supabase. That's fine
// for engineers; for operators we need a UI surface. Same data, friendlier.

async function handleAuctionInspect(req, res) {
  if (!_liveActivityAdminAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  const sb = supa();
  if (!sb) {
    // Demo mode — return empty list / 404 detail.
    if (req.query && req.query.id) {
      return res.status(404).json({ error: "Not found (demo mode)" });
    }
    return res.status(200).json({ mode: "demo", count: 0, logs: [] });
  }

  // ── Detail mode ──
  const id = req.query && req.query.id;
  if (id) {
    const { data, error } = await sb.from("auction_logs")
      .select("*").eq("auction_id", id).maybeSingle();
    if (error)   return res.status(500).json({ error: error.message });
    if (!data)   return res.status(404).json({ error: "Auction not found" });

    // Backfill publisher + winner names for friendlier display.
    let publisher = null, winner_campaign = null;
    if (data.publisher_id) {
      const { data: dev } = await sb.from("developers")
        .select("id, email, app_name").eq("id", data.publisher_id).maybeSingle();
      if (dev) publisher = dev;
    }
    if (data.winner_campaign_id) {
      const { data: camp } = await sb.from("campaigns")
        .select("id, name, advertiser_id, cta_url").eq("id", data.winner_campaign_id).maybeSingle();
      if (camp) winner_campaign = camp;
    }

    // ── Phase H Panel 3 (post-patch) — post-auction event timeline ──
    // Join the events table by auction_id so an operator can answer
    // "did the impression beacon fire? click? conversion?" without
    // pivoting to SQL. Idempotency partial index events_auction_type_unique
    // (db/04_bbx_mcp_extensions.sql) means at most one row per
    // (auction_id, event_type) pair — we can rely on that for "fired? yes/no".
    const { data: eventsRows } = await sb.from("events")
      .select("id, event_type, created_at, cost, developer_payout, conversion_type, value_cents, external_id, currency, surface, integration_method, ip_country, ip_region, ip_city, is_sandbox")
      .eq("auction_id", String(data.auction_id))
      .order("created_at", { ascending: true });

    // Build a timeline keyed by event_type so the UI can show "✓ fired"
    // / "✗ not fired" cells without scanning the array each render.
    const TIMELINE_KEYS = ["impression", "click", "close", "skip", "video_complete", "conversion", "dismiss", "error"];
    const timeline = {};
    for (const k of TIMELINE_KEYS) timeline[k] = null;
    for (const e of (eventsRows || [])) {
      // Normalise value_cents → value_usd for the UI; keep raw value_cents
      // available for callers that want it.
      const value_usd = (e.value_cents != null && Number.isFinite(Number(e.value_cents)))
        ? +(Number(e.value_cents) / 100).toFixed(2)
        : null;
      timeline[e.event_type] = {
        id: e.id,
        fired_at: e.created_at,
        cost_usd: Number(e.cost) || 0,
        developer_payout_usd: Number(e.developer_payout) || 0,
        conversion_type: e.conversion_type || null,
        value_usd,
        value_cents: e.value_cents,
        external_id: e.external_id || null,
        currency: e.currency || "USD",
        surface: e.surface || null,
        integration_method: e.integration_method || null,
        geo: [e.ip_city, e.ip_region, e.ip_country].filter(Boolean).join(", ") || null,
        is_sandbox: !!e.is_sandbox,
      };
    }

    // ── Publisher credit summary ──
    // Was the publisher share credited? We can't show a per-event balance audit (no
    // history table; bbx_credit_publisher_balance does an atomic UPSERT)
    // but the developer_payout column ON the impression row IS the
    // ground truth for "what was credited at impression time". We also
    // pull the current publisher_balance snapshot for context so the
    // operator can see whether the credit landed in lifetime_earned.
    let publisher_credit = {
      credited_at_impression: false,
      credited_amount_usd:    0,
      credit_event_id:        null,
      // 'auction time' = the impression event's created_at. Closest thing
      // we have to "when was the credit applied" without a balance ledger.
      credit_timestamp:       null,
      // current snapshot for the publisher (lets the operator confirm
      // the credit landed in lifetime_earned and the balance is sane).
      current_balance:        null,
      lifetime_earned:        null,
      lifetime_paid:          null,
      // Sandbox impressions never credit publisher_balance (Phase E Day 2
      // hardening — we don't accrue funny money). Surfacing this so
      // "no credit found" doesn't look like a bug when it's actually
      // a sandbox auction.
      reason_not_credited:    null,
    };
    if (timeline.impression) {
      const imp = timeline.impression;
      publisher_credit.credit_timestamp = imp.fired_at;
      publisher_credit.credit_event_id  = imp.id;
      if (imp.is_sandbox) {
        publisher_credit.reason_not_credited = "Sandbox auction — publisher_balance is not credited for sandbox traffic.";
      } else if (imp.developer_payout_usd > 0) {
        publisher_credit.credited_at_impression = true;
        publisher_credit.credited_amount_usd    = imp.developer_payout_usd;
      } else if (!data.publisher_id) {
        publisher_credit.reason_not_credited = "No publisher_id on auction — payout not attributable to any developer.";
      } else {
        publisher_credit.reason_not_credited = "Impression fired but developer_payout was zero. Possible causes: campaign in clawback, publisher in pending status, revenue_share_pct = 0.";
      }
    } else if (data.publisher_id) {
      publisher_credit.reason_not_credited = "Impression beacon never fired — there is nothing to credit.";
    }
    if (data.publisher_id) {
      const { data: pb } = await sb.from("publisher_balance")
        .select("balance, lifetime_earned, lifetime_paid")
        .eq("developer_id", data.publisher_id).maybeSingle();
      if (pb) {
        publisher_credit.current_balance = Number(pb.balance) || 0;
        publisher_credit.lifetime_earned = Number(pb.lifetime_earned) || 0;
        publisher_credit.lifetime_paid   = Number(pb.lifetime_paid) || 0;
      }
    }

    return res.status(200).json({
      auction: data,
      publisher,
      winner_campaign,
      timeline,
      publisher_credit,
    });
  }

  // ── List mode ──
  const limit       = Math.min(200, parseInt((req.query && req.query.limit) || "50", 10) || 50);
  const outcome     = req.query && req.query.outcome;          // won|no_match|below_floor|rate_limited|sandbox|error
  const publisherId = req.query && req.query.publisher_id;
  const integration = req.query && req.query.integration_method; // mcp|js-snippet|npm-sdk|rest-api
  const sandbox     = (req.query && req.query.mode === "sandbox") ? true : false;

  let q = sb.from("auction_logs")
    .select("auction_id, ts, surface, publisher_id, publisher_domain, integration_method, is_sandbox, outcome, no_fill_reason, winner_campaign_id, winning_price_cpm, latency_ms")
    .eq("is_sandbox", sandbox)
    .order("ts", { ascending: false }).limit(limit);
  if (outcome)     q = q.eq("outcome", outcome);
  if (publisherId) q = q.eq("publisher_id", publisherId);
  if (integration) q = q.eq("integration_method", integration);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Bulk-fetch publisher emails + campaign names to enrich list display.
  const pubIds  = [...new Set((data || []).map((r) => r.publisher_id).filter(Boolean))];
  const winIds  = [...new Set((data || []).map((r) => r.winner_campaign_id).filter(Boolean))];
  const [pubsRes, winsRes] = await Promise.all([
    pubIds.length ? sb.from("developers").select("id, email, app_name").in("id", pubIds) : { data: [] },
    winIds.length ? sb.from("campaigns").select("id, name").in("id", winIds) : { data: [] },
  ]);
  const pubMap = new Map((pubsRes.data || []).map((d) => [d.id, d]));
  const winMap = new Map((winsRes.data || []).map((c) => [c.id, c]));

  const logs = (data || []).map((r) => ({
    ...r,
    publisher_email:    r.publisher_id      ? (pubMap.get(r.publisher_id)      || {}).email : null,
    publisher_app_name: r.publisher_id      ? (pubMap.get(r.publisher_id)      || {}).app_name : null,
    winner_campaign_name: r.winner_campaign_id ? (winMap.get(r.winner_campaign_id) || {}).name : null,
  }));

  return res.status(200).json({
    count: logs.length,
    filters: { outcome: outcome || null, publisher_id: publisherId || null, integration_method: integration || null, sandbox },
    logs,
  });
}

// ── Exports for testing ───────────────────────────────────────────────
module.exports.HAS_SUPABASE = HAS_SUPABASE;
module.exports._handleLiveActivity = handleLiveActivity;
module.exports._handleMoneyFlow = handleMoneyFlow;
module.exports._handleAuctionInspect = handleAuctionInspect;
