const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const params = req.method === "GET" ? req.query : req.body;

  const event = params.event;
  const campaign_id = params.campaign_id;
  const session_id = params.session || params.session_id || null;
  const developer_id = params.dev || params.developer_id || null;

  if (!event || !campaign_id) {
    return res.status(400).json({ error: "Missing event or campaign_id" });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Insert event
  const record = {
    event_type: event,
    campaign_id,
    session_id,
    developer_id: developer_id || null,
    ip_country: req.headers["x-vercel-ip-country"] || "unknown",
    ip_region: req.headers["x-vercel-ip-country-region"] || "unknown",
    ip_city: req.headers["x-vercel-ip-city"] || "unknown",
    user_language: params.lang || "en",
    user_agent: req.headers["user-agent"] || "",
  };

  const { error } = await supabase.from("events").insert(record);

  // Calculate cost and update campaign spend
  if (!error && (event === "impression" || event === "click" || event === "video_complete")) {
    // Fetch campaign billing info
    const { data: campaign } = await supabase
      .from("campaigns")
      .select("billing_model, bid_amount, spent_today, spent_total")
      .eq("id", campaign_id)
      .single();

    if (campaign) {
      let cost = 0;
      if (event === "impression" && campaign.billing_model === "cpm") {
        cost = campaign.bid_amount / 1000; // CPM = per 1000
      } else if (event === "click" && campaign.billing_model === "cpc") {
        cost = campaign.bid_amount;
      } else if (event === "video_complete" && campaign.billing_model === "cpv") {
        cost = campaign.bid_amount;
      }

      if (cost > 0) {
        // Update campaign spend
        await supabase
          .from("campaigns")
          .update({
            spent_today: (campaign.spent_today || 0) + cost,
            spent_total: (campaign.spent_total || 0) + cost,
          })
          .eq("id", campaign_id);

        // Update event with cost
        // Developer payout = 65% of cost
        const devPayout = cost * 0.65;
        await supabase
          .from("events")
          .update({ cost, developer_payout: devPayout })
          .eq("campaign_id", campaign_id)
          .eq("session_id", session_id)
          .eq("event_type", event)
          .order("created_at", { ascending: false })
          .limit(1);
      }
    }
  }

  // Return 1x1 pixel for GET (pixel tracking from img tags)
  if (req.method === "GET") {
    const pixel = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Cache-Control", "no-store");
    return res.send(pixel);
  }

  return res.json({ tracked: !error, event, campaign_id });
};
