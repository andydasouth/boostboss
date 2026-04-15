const { createClient } = require("@supabase/supabase-js");

/**
 * Boost Boss — Stats API
 * GET /api/stats?type=advertiser&id=xxx
 * GET /api/stats?type=developer&key=xxx
 */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!url || !key) {
      return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars" });
    }

    const supabase = createClient(url, key);
    const { type, id, key: devKey } = req.query;

    // ── Advertiser Stats ──
    if (type === "advertiser" && id) {
      const { data: campaigns, error: cErr } = await supabase
        .from("campaigns")
        .select("*")
        .eq("advertiser_id", id)
        .order("created_at", { ascending: false });

      if (cErr) return res.status(500).json({ error: cErr.message });

      const campaignIds = (campaigns || []).map(c => c.id);

      let dailyStats = [];
      if (campaignIds.length > 0) {
        const { data } = await supabase
          .from("daily_stats")
          .select("*")
          .in("campaign_id", campaignIds)
          .order("date", { ascending: true })
          .limit(60);
        dailyStats = data || [];
      }

      let totalImpressions = 0, totalClicks = 0, totalSpend = 0;
      for (const s of dailyStats) {
        totalImpressions += s.impressions || 0;
        totalClicks += s.clicks || 0;
        totalSpend += parseFloat(s.spend || 0);
      }

      return res.json({
        campaigns: campaigns || [],
        daily: dailyStats,
        totals: {
          impressions: totalImpressions,
          clicks: totalClicks,
          ctr: totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : "0.00",
          spend: totalSpend.toFixed(2),
        },
      });
    }

    // ── Developer Stats ──
    if (type === "developer" && devKey) {
      const { data: dev, error: dErr } = await supabase
        .from("developers")
        .select("*")
        .eq("api_key", devKey)
        .single();

      if (dErr || !dev) return res.status(404).json({ error: "Developer not found", detail: dErr?.message });

      const { data: dailyStats } = await supabase
        .from("daily_stats")
        .select("*")
        .eq("developer_id", dev.id)
        .order("date", { ascending: true })
        .limit(60);

      let totalImpressions = 0, totalClicks = 0, totalEarnings = 0;
      for (const s of dailyStats || []) {
        totalImpressions += s.impressions || 0;
        totalClicks += s.clicks || 0;
        totalEarnings += parseFloat(s.developer_earnings || 0);
      }

      return res.json({
        developer: {
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
        },
        daily: dailyStats || [],
        totals: {
          impressions: totalImpressions,
          clicks: totalClicks,
          earnings: totalEarnings.toFixed(2),
          rpm: totalImpressions > 0 ? ((totalEarnings / totalImpressions) * 1000).toFixed(2) : "0.00",
        },
      });
    }

    return res.status(400).json({ error: "Missing type (advertiser|developer) and id/key params" });

  } catch (err) {
    console.error("[BoostBoss Stats Error]", err);
    return res.status(500).json({ error: "Internal server error", message: err.message });
  }
};
