const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

function getSupabase() {
  return createClient(supabaseUrl, supabaseKey);
}

// Rate limiting per session
const sessionCache = new Map();
const RATE_LIMIT_MS = 3 * 60 * 1000;

function scoreCampaign(campaign, context, userRegion, userLanguage) {
  const ctx = (context || "").toLowerCase();
  let score = 0;

  // Keyword matching
  const keywords = campaign.target_keywords || [];
  for (const kw of keywords) {
    if (ctx.includes(kw.toLowerCase())) score += 10;
  }

  // Region
  const regions = campaign.target_regions || ["global"];
  if (regions.includes("global") || regions.includes(userRegion)) {
    score += 5;
  } else {
    score -= 10;
  }

  // Language
  const langs = campaign.target_languages || ["en"];
  if (langs.includes(userLanguage)) score += 3;

  // Budget remaining
  const left = (campaign.total_budget || 0) - (campaign.spent_total || 0);
  if (left > 0) score += Math.min(left / 500, 5);

  // Daily cap
  if ((campaign.spent_today || 0) >= (campaign.daily_budget || 0)) score = -999;

  return score;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body;

  // ── initialize ──
  if (body.method === "initialize") {
    return res.json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "boostboss-mcp", version: "1.0.0", description: "Boost Boss — MCP Ad Network", url: "https://boostboss.ai" },
      },
    });
  }

  // ── tools/list ──
  if (body.method === "tools/list") {
    return res.json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: [
          {
            name: "get_sponsored_content",
            description: "Get a contextually relevant sponsored recommendation matched to conversation context.",
            inputSchema: {
              type: "object",
              properties: {
                context_summary: { type: "string", description: "What the user is currently working on or asking about" },
                user_region: { type: "string", description: "Region: US, EU, APAC, LATAM, global" },
                user_language: { type: "string", description: "Language: en, zh, es, ja, ko" },
                session_id: { type: "string", description: "Unique session ID" },
                developer_api_key: { type: "string", description: "Developer Boost Boss API key" },
                format_preference: { type: "string", enum: ["image", "video", "native", "any"] },
              },
              required: ["context_summary"],
            },
          },
          {
            name: "track_event",
            description: "Track ad event: impression, click, close, video_complete, skip",
            inputSchema: {
              type: "object",
              properties: {
                event: { type: "string", enum: ["impression", "click", "close", "video_complete", "skip"] },
                campaign_id: { type: "string" },
                session_id: { type: "string" },
                developer_api_key: { type: "string" },
              },
              required: ["event", "campaign_id"],
            },
          },
        ],
      },
    });
  }

  // ── tools/call ──
  if (body.method === "tools/call") {
    const toolName = body.params?.name;
    const args = body.params?.arguments || {};
    const supabase = getSupabase();

    if (toolName === "get_sponsored_content") {
      const sessionId = args.session_id || "anon_" + Date.now();

      // Rate limit
      const last = sessionCache.get(sessionId);
      if (last && Date.now() - last < RATE_LIMIT_MS) {
        return res.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ sponsored: null, reason: "rate_limited" }) }] } });
      }

      // Resolve developer
      let developerId = null;
      if (args.developer_api_key) {
        const { data: dev } = await supabase.from("developers").select("id").eq("api_key", args.developer_api_key).eq("status", "active").single();
        if (dev) developerId = dev.id;
      }

      // Fetch active campaigns
      const { data: campaigns, error } = await supabase.from("campaigns").select("*").eq("status", "active");
      if (error || !campaigns || campaigns.length === 0) {
        return res.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ sponsored: null, reason: "no_campaigns" }) }] } });
      }

      // Score & rank
      const region = args.user_region || "global";
      const lang = args.user_language || "en";
      const ranked = campaigns
        .map(c => ({ c, score: scoreCampaign(c, args.context_summary, region, lang) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score);

      if (ranked.length === 0) {
        return res.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ sponsored: null, reason: "no_match" }) }] } });
      }

      const w = ranked[0].c;
      sessionCache.set(sessionId, Date.now());

      const baseTrack = `https://boostboss.ai/api/track?campaign_id=${w.id}&session=${sessionId}&dev=${developerId || ""}`;

      return res.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              sponsored: {
                campaign_id: w.id,
                type: w.format,
                headline: w.headline,
                subtext: w.subtext,
                media_url: w.media_url,
                poster_url: w.poster_url || null,
                cta_label: w.cta_label,
                cta_url: w.cta_url,
                skippable_after_sec: w.skippable_after_sec || 3,
                tracking: {
                  impression: `${baseTrack}&event=impression`,
                  click: `${baseTrack}&event=click`,
                  close: `${baseTrack}&event=close`,
                  video_complete: `${baseTrack}&event=video_complete`,
                },
              },
            }),
          }],
        },
      });
    }

    if (toolName === "track_event") {
      const { error } = await supabase.from("events").insert({
        event_type: args.event,
        campaign_id: args.campaign_id,
        session_id: args.session_id || null,
      });
      return res.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ tracked: !error }) }] } });
    }

    return res.status(400).json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
  }

  return res.status(400).json({ error: "Unknown MCP method" });
};
