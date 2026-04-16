// Example: serve a sponsored recommendation inside a Cursor extension
// when the user has been debugging Python for > 2 minutes.
//
//   npm install @boostboss/sdk
//
const { BoostBoss } = require("@boostboss/sdk");

const bb = new BoostBoss({
  apiKey: process.env.BB_API_KEY,
  region: "us-west",
});

async function maybeShowSponsoredFix(userContext) {
  const { sponsored, benna } = await bb.getSponsoredContent({
    context: userContext.lastCommand + " " + userContext.errorText,
    host: "cursor.com",
    format: "native",
    sessionLenMin: userContext.sessionMinutes,
  });

  if (!sponsored) return null;

  // Log Benna attribution for observability
  console.log(`[bb] served ${sponsored.campaign_id}  bid=$${benna.bid_usd}  p_click=${benna.p_click}`);

  // Render in Cursor's side panel as a native hint
  return {
    kind: "sponsored_hint",
    title: sponsored.headline,
    body: sponsored.subtext,
    cta: { label: sponsored.cta_label, url: sponsored.cta_url },
    on_view: () => bb.trackEvent("impression", sponsored.campaign_id),
    on_click: () => bb.trackEvent("click", sponsored.campaign_id),
  };
}

module.exports = { maybeShowSponsoredFix };
