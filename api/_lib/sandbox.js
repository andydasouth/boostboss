/**
 * Boost Boss — Sandbox mode
 *
 * When a publisher uses a sandbox credential (publisher ID prefixed with
 * `pub_test_` or API key prefixed with `sk_test_`), the auction is short-
 * circuited and a fixed creative from a small rotation pool is returned.
 *
 * Goals (per docs/mcp + advisor guidance):
 *   • No signup required to try the SDK end-to-end
 *   • Match production response shape and headers exactly
 *   • Diverge ONLY on creative selection, billing, attribution
 *   • Tag rows so dashboard queries can filter sandbox traffic out
 *   • Beacons fire to the same /api/track endpoint with `&sandbox=1` so
 *     track.js short-circuits cost computation and sets is_sandbox=true
 *   • Rotate across a small pool so publishers exercise rendering against
 *     more than one creative shape
 */

const SANDBOX_CREATIVES = [
  {
    campaign_id: "cmp_sandbox_devtools_native",
    advertiser_name: "Boost Boss Sandbox",
    type: "native",
    headline: "[Sandbox] DevTools Pro — your IDE on caffeine",
    subtext: "Refactor 3× faster with AI pair programming. 14-day free trial.",
    media_url: null,
    poster_url: null,
    cta_label: "Start free trial",
    cta_url: "https://boostboss.ai/sandbox-click?creative=devtools_native",
    disclosure_label: "Sponsored · TEST",
  },
  {
    campaign_id: "cmp_sandbox_billing_native",
    advertiser_name: "Boost Boss Sandbox",
    type: "native",
    headline: "[Sandbox] Stripe Atlas — launch a US company in 2 days",
    subtext: "Incorporation, EIN, bank account. $500 flat. No legal fees.",
    media_url: null,
    poster_url: null,
    cta_label: "Launch your company",
    cta_url: "https://boostboss.ai/sandbox-click?creative=billing_native",
    disclosure_label: "Sponsored · TEST",
  },
  {
    campaign_id: "cmp_sandbox_image",
    advertiser_name: "Boost Boss Sandbox",
    type: "image",
    headline: "[Sandbox] Acme Cloud — deploy in seconds, not minutes",
    subtext: "Edge functions, zero cold starts, 200 PoPs.",
    media_url: "https://placehold.co/540x304/0F0F1A/FFE600?text=TEST+CREATIVE",
    poster_url: null,
    cta_label: "Try Acme",
    cta_url: "https://boostboss.ai/sandbox-click?creative=image",
    disclosure_label: "Sponsored · TEST",
  },
  {
    campaign_id: "cmp_sandbox_banner",
    advertiser_name: "Boost Boss Sandbox",
    type: "banner",
    headline: "[Sandbox] Acme Vector DB — semantic search for AI apps",
    subtext: "Open-source, p99 < 5ms, hosted or self-managed.",
    media_url: "https://placehold.co/728x90/0F0F1A/FFE600?text=TEST+CREATIVE",
    poster_url: null,
    cta_label: "View pricing",
    cta_url: "https://boostboss.ai/sandbox-click?creative=banner",
    disclosure_label: "Sponsored · TEST",
  },
  {
    campaign_id: "cmp_sandbox_minimal",
    advertiser_name: "Boost Boss Sandbox",
    type: "native",
    headline: "[Sandbox] This is a test creative.",
    subtext: "You're seeing it because your publisher ID starts with pub_test_. Switch to your live ID before going to production.",
    media_url: null,
    poster_url: null,
    cta_label: "Read the docs",
    cta_url: "https://boostboss.ai/docs/mcp",
    disclosure_label: "Sponsored · TEST",
  },
];

function isSandboxCredential(args) {
  if (!args || typeof args !== "object") return false;
  const apiKey      = String(args.developer_api_key || "");
  const publisherId = String(args.publisher_id || "");
  return (
    publisherId.startsWith("pub_test_") ||
    apiKey.startsWith("pub_test_") ||  // tolerate confusion: pub_test_demo passed as apiKey
    apiKey.startsWith("sk_test_")
  );
}

/**
 * Pick a sandbox creative. Rotates per session so each session sees a
 * stable creative (avoids flicker on retry) but different sessions get
 * different creatives — which exercises the publisher's render code
 * across the full pool over time.
 */
function pickSandboxCreative(sessionId, formatPreference) {
  const filtered = formatPreference
    ? SANDBOX_CREATIVES.filter((c) => c.type === formatPreference)
    : SANDBOX_CREATIVES;
  const pool = filtered.length > 0 ? filtered : SANDBOX_CREATIVES;
  const seed = String(sessionId || "anon").split("").reduce(
    (h, ch) => ((h << 5) - h + ch.charCodeAt(0)) | 0, 0
  );
  return pool[Math.abs(seed) % pool.length];
}

/**
 * Build the full `sponsored` payload for a sandbox response. Same shape
 * as the production auction returns — diverges only in:
 *   • campaign_id (always cmp_sandbox_*)
 *   • cta_url (sandbox redirect)
 *   • tracking URLs include `&sandbox=1` so track.js skips billing
 *   • disclosure_label includes "TEST" suffix
 */
function buildSandboxResponse({ auctionId, base, sessionId, args }) {
  const formatPref = args.format_preference || null;
  const c = pickSandboxCreative(sessionId, formatPref);

  // Beacon URLs — same /api/track endpoint, but flagged sandbox=1 so
  // track.js skips cost computation and writes is_sandbox=true.
  const trackParams = new URLSearchParams({
    campaign_id: c.campaign_id,
    session: sessionId,
    auction:  auctionId,
    sandbox:  "1",
  });
  if (args.surface) trackParams.set("surface", args.surface);
  if (c.type)       trackParams.set("format", c.type);
  const track = `${base}/api/track?${trackParams.toString()}`;

  // Append the sandbox auction id to the cta_url so attribution is
  // unambiguous in dev logs even though no real conversion will fire.
  const sep = c.cta_url.includes("?") ? "&" : "?";
  const ctaUrl = `${c.cta_url}${sep}bbx_auc=${encodeURIComponent(auctionId)}&bbx_sandbox=1`;

  return {
    sponsored: {
      campaign_id: c.campaign_id,
      advertiser_name: c.advertiser_name,
      type: c.type,
      headline: c.headline,
      subtext: c.subtext,
      media_url: c.media_url,
      poster_url: c.poster_url,
      cta_label: c.cta_label,
      cta_url: ctaUrl,
      skippable_after_sec: 3,
      disclosure_label: c.disclosure_label,
      tracking: {
        impression:     `${track}&event=impression`,
        click:          `${track}&event=click`,
        close:          `${track}&event=close`,
        video_complete: `${track}&event=video_complete`,
      },
    },
    auction: {
      auction_id: auctionId,
      placement_id: null,
      surface: args.surface || null,
      format: c.type,
      floor_cpm: null,
      winning_price_cpm: 0,
      intent_match_score: null,
      candidates_considered: SANDBOX_CREATIVES.length,
      sandbox: true,
    },
  };
}

module.exports = {
  isSandboxCredential,
  pickSandboxCreative,
  buildSandboxResponse,
  SANDBOX_CREATIVES,
};
