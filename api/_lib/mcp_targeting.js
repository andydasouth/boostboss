/**
 * Boost Boss — MCP-native targeting helpers
 *
 * Shared between api/mcp.js (JSON-RPC supply) and api/rtb.js (OpenRTB supply)
 * so both auction surfaces apply identical eligibility and intent-match
 * semantics. Mirrors the SQL function bbx_eligible_campaigns() — the SQL
 * version is the source of truth; this is the in-process equivalent for
 * the hot path that loads campaigns into memory and ranks them locally.
 *
 * See protocol §9 for the scoring formula and §4.1 for the field shapes.
 */

/**
 * Returns true if a campaign passes the MCP targeting filters (surface,
 * host_app, active_tools). Each rule short-circuits to PASS when the
 * campaign has no preference (empty array). Active-tools is an *overlap*
 * test — campaign passes if any of its target tools are connected.
 *
 * If a campaign declares target_active_tools but the request didn't
 * include any active_tools, the campaign is excluded — it asked for a
 * specific tool context that isn't present.
 */
function mcpTargetingMatch(campaign, ctx) {
  const surfaces = campaign.target_surfaces || [];
  if (surfaces.length > 0 && ctx.surface && !surfaces.includes(ctx.surface)) {
    return false;
  }

  const hosts = campaign.target_host_apps || [];
  if (hosts.length > 0 && ctx.host_app && !hosts.includes(ctx.host_app)) {
    return false;
  }

  const tools = campaign.target_active_tools || [];
  if (tools.length > 0) {
    const reqTools = Array.isArray(ctx.active_tools) ? ctx.active_tools : [];
    if (reqTools.length === 0) return false;
    const overlap = tools.some((t) => reqTools.includes(t));
    if (!overlap) return false;
  }

  return true;
}

/**
 * Cosine-style intent match score, clipped to [0.2, 1.5] per protocol §9.
 *
 * Without embeddings (Benna v0 stub), we use a normalised Jaccard with a
 * soft floor so campaigns that don't declare intent_tokens still bid at
 * neutral (1.0). Once embeddings ship, swap the body of this function for
 * a cosine call against pre-computed campaign vectors.
 */
function intentMatchScore(reqTokens, campaignTokens) {
  const a = (reqTokens || []).map((t) => String(t).toLowerCase());
  const b = (campaignTokens || []).map((t) => String(t).toLowerCase());
  if (a.length === 0 || b.length === 0) return 1.0; // neutral when either side is empty

  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  if (union === 0) return 1.0;

  // Jaccard ∈ [0, 1]; rescale to [0.2, 1.5] so positive overlap rewards.
  const j = inter / union;
  return Math.max(0.2, Math.min(1.5, 0.4 + j * 1.4));
}

/**
 * Generate a BBX auction id (timestamp + random suffix). Not strict ULID,
 * just unique-enough for tracking-URL idempotency.
 */
function mintAuctionId() {
  const ts = Date.now().toString(36).padStart(9, "0");
  const r = Math.random().toString(36).slice(2, 14);
  return "ach_" + ts + r;
}

module.exports = {
  mcpTargetingMatch,
  intentMatchScore,
  mintAuctionId,
};
