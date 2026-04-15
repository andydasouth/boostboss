const { createClient } = require("@supabase/supabase-js");

/**
 * Boost Boss — Campaigns API
 * POST /api/campaigns — Create a new campaign
 * GET  /api/campaigns?advertiser_id=xxx — List campaigns
 */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Use service role key for server-side operations (bypasses RLS)
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  const supabase = createClient(process.env.SUPABASE_URL, supabaseKey);

  // ── List campaigns ──
  if (req.method === "GET") {
    const { advertiser_id } = req.query;
    if (!advertiser_id) return res.status(400).json({ error: "Missing advertiser_id" });

    const { data, error } = await supabase
      .from("campaigns")
      .select("*")
      .eq("advertiser_id", advertiser_id)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ campaigns: data });
  }

  // ── Create campaign ──
  if (req.method === "POST") {
    const {
      advertiser_id, name, format, headline, subtext,
      media_url, poster_url, cta_label, cta_url,
      target_keywords, target_regions, target_languages,
      billing_model, bid_amount, daily_budget, total_budget,
      skippable_after_sec,
    } = req.body;

    if (!advertiser_id || !name || !format || !headline || !cta_url) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { data, error } = await supabase.from("campaigns").insert({
      advertiser_id,
      name,
      status: "in_review",
      format,
      headline,
      subtext: subtext || "",
      media_url: media_url || "",
      poster_url: poster_url || null,
      cta_label: cta_label || "Learn More →",
      cta_url,
      target_keywords: target_keywords || [],
      target_regions: target_regions || ["global"],
      target_languages: target_languages || ["en"],
      billing_model: billing_model || "cpm",
      bid_amount: bid_amount || 5.00,
      daily_budget: daily_budget || 50.00,
      total_budget: total_budget || 1000.00,
      skippable_after_sec: skippable_after_sec || 3,
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ campaign: data });
  }

  // ── Update campaign ──
  if (req.method === "PATCH") {
    const { id, status, name, headline, subtext, cta_label, cta_url, daily_budget, total_budget, bid_amount } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Missing campaign id" });
    }

    const updateData = {};
    if (status !== undefined) updateData.status = status;
    if (name !== undefined) updateData.name = name;
    if (headline !== undefined) updateData.headline = headline;
    if (subtext !== undefined) updateData.subtext = subtext;
    if (cta_label !== undefined) updateData.cta_label = cta_label;
    if (cta_url !== undefined) updateData.cta_url = cta_url;
    if (daily_budget !== undefined) updateData.daily_budget = daily_budget;
    if (total_budget !== undefined) updateData.total_budget = total_budget;
    if (bid_amount !== undefined) updateData.bid_amount = bid_amount;

    const { data, error } = await supabase
      .from("campaigns")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ campaign: data });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
