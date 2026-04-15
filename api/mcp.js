/**
 * Boost Boss — MCP Ad Server
 *
 * Vercel Serverless Function
 * Handles MCP protocol handshake + ad serving
 *
 * Endpoint: POST /api/mcp
 */

// In production, these come from Supabase
const AD_CATALOG = [
  {
    id: "bb_001",
    advertiser: "Framer",
    type: "image",
    headline: "Build stunning sites — no code needed",
    subtext: "Framer · Free for 30 days · 2M+ creators",
    media_url: "https://placehold.co/540x304/f97316/ffffff?text=Framer",
    cta_label: "Try Free →",
    cta_url: "https://framer.com",
    skippable_after_sec: 3,
    targeting: {
      keywords: ["landing page", "design", "website", "no-code", "UI", "builder", "startup"],
      regions: ["global"],
      languages: ["en", "zh", "es", "ja"],
    },
    budget_remaining: 500,
    cpm: 5.00,
    cpc: 0.50,
    status: "active",
  },
  {
    id: "bb_002",
    advertiser: "Vercel",
    type: "image",
    headline: "Deploy in seconds. Scale forever.",
    subtext: "Vercel · Free hobby plan · Netflix, Uber, GitHub trust us",
    media_url: "https://placehold.co/540x304/000000/ffffff?text=Vercel",
    cta_label: "Deploy Now →",
    cta_url: "https://vercel.com",
    skippable_after_sec: 3,
    targeting: {
      keywords: ["deploy", "hosting", "server", "scale", "frontend", "next.js", "react"],
      regions: ["global"],
      languages: ["en"],
    },
    budget_remaining: 800,
    cpm: 6.00,
    cpc: 0.60,
    status: "active",
  },
  {
    id: "bb_003",
    advertiser: "Cursor",
    type: "video",
    headline: "Code 10x faster with AI",
    subtext: "Cursor · AI-first IDE · 1M+ developers",
    media_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
    poster_url: "https://placehold.co/540x304/6366f1/ffffff?text=Cursor+AI",
    cta_label: "Download Free →",
    cta_url: "https://cursor.com",
    skippable_after_sec: 5,
    targeting: {
      keywords: ["code", "programming", "IDE", "developer", "python", "javascript", "build", "debug"],
      regions: ["global"],
      languages: ["en", "zh", "ja"],
    },
    budget_remaining: 1200,
    cpm: 8.00,
    cpc: 0.80,
    status: "active",
  },
  {
    id: "bb_004",
    advertiser: "Notion",
    type: "image",
    headline: "All your work. One tool. AI-powered.",
    subtext: "Notion · Free for personal · 30M+ teams",
    media_url: "https://placehold.co/540x304/0ea5e9/ffffff?text=Notion+AI",
    cta_label: "Get Notion Free →",
    cta_url: "https://notion.so",
    skippable_after_sec: 3,
    targeting: {
      keywords: ["notes", "organize", "project", "team", "wiki", "document", "plan", "manage"],
      regions: ["global"],
      languages: ["en", "zh", "es", "ja", "ko"],
    },
    budget_remaining: 600,
    cpm: 4.50,
    cpc: 0.40,
    status: "active",
  },
];

// Rate limiting: track sessions
const sessionLastServed = new Map();
const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes between ads per session

/**
 * Match the best ad to the conversation context
 */
function matchAd(context, userRegion, userLanguage) {
  const contextLower = (context || "").toLowerCase();
  const activeAds = AD_CATALOG.filter(ad => ad.status === "active" && ad.budget_remaining > 0);

  // Score each ad by keyword relevance
  const scored = activeAds.map(ad => {
    let score = 0;

    // Keyword matching
    for (const kw of ad.targeting.keywords) {
      if (contextLower.includes(kw.toLowerCase())) {
        score += 10;
      }
    }

    // Region match bonus
    if (ad.targeting.regions.includes("global") || ad.targeting.regions.includes(userRegion)) {
      score += 5;
    }

    // Language match bonus
    if (ad.targeting.languages.includes(userLanguage)) {
      score += 3;
    }

    // Budget priority — higher budget remaining = slight boost
    score += ad.budget_remaining / 1000;

    return { ad, score };
  });

  // Sort by score descending, return best match
  scored.sort((a, b) => b.score - a.score);
  return scored.length > 0 && scored[0].score > 0 ? scored[0].ad : null;
}

/**
 * Handle MCP Protocol
 */
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body;

  // ── MCP Handshake ──
  if (body.method === "initialize") {
    return res.json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "boostboss-ad-server",
          version: "1.0.0",
          description: "Boost Boss — MCP Ad Network for AI Applications",
        },
      },
    });
  }

  // ── List Tools ──
  if (body.method === "tools/list") {
    return res.json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: [
          {
            name: "get_sponsored_content",
            description: "Get a contextually relevant sponsored recommendation for the current conversation. Returns targeted content that may be useful to the user.",
            inputSchema: {
              type: "object",
              properties: {
                context_summary: {
                  type: "string",
                  description: "A brief summary of what the user is currently working on or asking about",
                },
                user_region: {
                  type: "string",
                  description: "User's region/timezone (e.g., 'US', 'EU', 'APAC')",
                },
                user_language: {
                  type: "string",
                  description: "User's language code (e.g., 'en', 'zh', 'es')",
                },
                session_id: {
                  type: "string",
                  description: "Unique session identifier for rate limiting",
                },
                format_preference: {
                  type: "string",
                  enum: ["image", "video", "native", "any"],
                  description: "Preferred ad format. Default: any",
                },
              },
              required: ["context_summary"],
            },
          },
          {
            name: "track_ad_event",
            description: "Track an ad event (impression, click, close, video_complete)",
            inputSchema: {
              type: "object",
              properties: {
                event: {
                  type: "string",
                  enum: ["impression", "click", "close", "video_complete", "skip"],
                },
                ad_id: { type: "string" },
                session_id: { type: "string" },
                developer_id: { type: "string" },
              },
              required: ["event", "ad_id"],
            },
          },
        ],
      },
    });
  }

  // ── Call Tool ──
  if (body.method === "tools/call") {
    const toolName = body.params?.name;
    const args = body.params?.arguments || {};

    // ── Get Sponsored Content ──
    if (toolName === "get_sponsored_content") {
      const sessionId = args.session_id || "anonymous";

      // Rate limit check
      const lastServed = sessionLastServed.get(sessionId);
      if (lastServed && Date.now() - lastServed < RATE_LIMIT_MS) {
        return res.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ sponsored: null, reason: "rate_limited", next_eligible_ms: RATE_LIMIT_MS - (Date.now() - lastServed) }),
              },
            ],
          },
        });
      }

      // Match ad
      const ad = matchAd(
        args.context_summary,
        args.user_region || "global",
        args.user_language || "en"
      );

      if (!ad) {
        return res.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ sponsored: null, reason: "no_match" }) }],
          },
        });
      }

      // Record serving
      sessionLastServed.set(sessionId, Date.now());

      // Return ad payload (SDK will render this)
      const payload = {
        sponsored: {
          ad_id: ad.id,
          advertiser: ad.advertiser,
          type: ad.type,
          headline: ad.headline,
          subtext: ad.subtext,
          media_url: ad.media_url,
          poster_url: ad.poster_url || null,
          cta_label: ad.cta_label,
          cta_url: ad.cta_url,
          skippable_after_sec: ad.skippable_after_sec,
          format_suggestion: args.format_preference === "any" ? (ad.type === "video" ? "corner" : "corner") : null,
          tracking: {
            impression_url: `https://api.boostboss.ai/api/track?event=impression&ad_id=${ad.id}&session=${sessionId}`,
            click_url: `https://api.boostboss.ai/api/track?event=click&ad_id=${ad.id}&session=${sessionId}`,
          },
        },
      };

      return res.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(payload) }],
        },
      });
    }

    // ── Track Event ──
    if (toolName === "track_ad_event") {
      // In production: write to Supabase
      console.log("[BoostBoss Track]", args);

      return res.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ tracked: true, event: args.event, ad_id: args.ad_id }) }],
        },
      });
    }

    return res.status(400).json({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: `Unknown tool: ${toolName}` },
    });
  }

  return res.status(400).json({ error: "Unknown MCP method" });
}
