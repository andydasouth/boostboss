/**
 * Boost Boss — Event Tracking API
 *
 * Endpoint: GET/POST /api/track
 * Tracks: impressions, clicks, video_complete, close, skip
 *
 * In production: writes to Supabase
 */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Accept both GET (pixel tracking) and POST (SDK calls)
  const params = req.method === "GET" ? req.query : req.body;

  const event = params.event;
  const ad_id = params.ad_id;
  const session_id = params.session || params.session_id || "unknown";
  const developer_id = params.developer_id || "unknown";
  const timestamp = new Date().toISOString();

  if (!event || !ad_id) {
    return res.status(400).json({ error: "Missing event or ad_id" });
  }

  const record = {
    event,
    ad_id,
    session_id,
    developer_id,
    timestamp,
    user_agent: req.headers["user-agent"] || "",
    ip_country: req.headers["x-vercel-ip-country"] || "unknown",
    ip_region: req.headers["x-vercel-ip-country-region"] || "unknown",
    ip_city: req.headers["x-vercel-ip-city"] || "unknown",
  };

  // TODO: Write to Supabase
  // const { data, error } = await supabase.from("events").insert(record);

  console.log("[BoostBoss Track]", JSON.stringify(record));

  // Return 1x1 transparent pixel for GET requests (pixel tracking)
  if (req.method === "GET") {
    const pixel = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64"
    );
    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Cache-Control", "no-store");
    return res.send(pixel);
  }

  return res.json({ tracked: true, ...record });
}
