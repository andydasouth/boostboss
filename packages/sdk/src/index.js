/**
 * @boostbossai/lumi-sdk — MCP Ad Network SDK
 *
 * Three ways to use:
 *
 *   1. Direct API call (any runtime):
 *        const bb = require("@boostbossai/lumi-sdk");
 *        const ad = await bb.getSponsoredContent({ context: "user is debugging python" });
 *
 *   2. MCP server middleware (wraps your existing MCP server):
 *        const { withBoostBoss } = require("@boostbossai/lumi-sdk/mcp");
 *        const server = withBoostBoss(yourMcpServer, { apiKey: process.env.BB_KEY });
 *
 *   3. Browser-side renderer (React/plain HTML):
 *        import { renderAd } from "@boostbossai/lumi-sdk/renderer";
 *        renderAd(ad, { mount: "#bb-ad-slot", format: "corner" });
 *
 * Every response is Benna-ranked against live MCP signals.
 * Docs: https://boostboss.ai/docs
 */

const DEFAULT_ENDPOINT = "https://boostboss.ai/api/mcp";
const SDK_VERSION = "1.1.0";

class BoostBoss {
  constructor(opts = {}) {
    if (!opts.apiKey && !process.env.BB_API_KEY) {
      // SDK is usable in read-only demo mode without a key.
      this._demoMode = true;
    }
    this.apiKey = opts.apiKey || process.env.BB_API_KEY || null;
    this.endpoint = opts.endpoint || DEFAULT_ENDPOINT;
    this.defaultRegion = opts.region || "global";
    this.defaultLanguage = opts.language || "en";
    this.timeoutMs = opts.timeoutMs || 3000;
    this.onEvent = opts.onEvent || null; // optional lifecycle hook
    this._sessionId = opts.sessionId || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // Default placement context — applied to every getSponsoredContent unless
    // the caller overrides per-call. Lets a publisher configure once and call
    // many times without repeating placement_id / surface every time.
    this.defaultPlacementId = opts.placementId || null;
    this.defaultSurface     = opts.surface || null;
    this.defaultHostApp     = opts.hostApp || null;
    // Auction-context cache (per-campaign): the most recent ad_response's
    // auction_id / placement_id / surface / format / intent_match_score, so
    // trackEvent can attach them automatically. Keyed by campaign_id.
    this._lastAuctionByCampaign = new Map();
  }

  /**
   * Request a Benna-ranked sponsored ad for the current MCP context.
   *
   * @param {object} params
   * @param {string}   params.context        Freeform summary of what the user is doing
   * @param {string}   [params.host]         Raw host / URL of the publisher app
   * @param {string}   [params.hostApp]      Canonical host app name for targeting:
   *                                         "cursor" | "claude_desktop" | "vscode" | "jetbrains"
   * @param {string}   [params.format]       "image" | "video" | "native" | "any"
   * @param {string}   [params.placementId]  Publisher placement_id (recommended) — enables
   *                                         floor + frequency cap + per-placement reporting.
   * @param {string}   [params.surface]      "chat" | "tool_response" | "sidebar" |
   *                                         "loading_screen" | "status_line" | "web"
   * @param {string[]} [params.intentTokens] Free-form intent strings advertisers bid against
   *                                         (e.g. ["billing_integration","stripe","saas"])
   * @param {string[]} [params.activeTools]  Canonical names of MCP servers connected
   *                                         (e.g. ["stripe-mcp","quickbooks-mcp"])
   * @param {number}   [params.sessionLenMin]
   * @returns {Promise<{sponsored: object|null, auction?: object, benna?: object}>}
   */
  async getSponsoredContent(params = {}) {
    const args = {
      context_summary: params.context || "",
      host: params.host || null,
      format_preference: params.format || "any",
      user_region: params.region || this.defaultRegion,
      user_language: params.language || this.defaultLanguage,
      session_id: this._sessionId,
      session_len_min: params.sessionLenMin,
      developer_api_key: this.apiKey,
      // BBX MCP-native fields (protocol §4.1). Per-call values fall back to
      // constructor defaults so a publisher can configure once.
      placement_id: params.placementId || this.defaultPlacementId,
      surface:      params.surface     || this.defaultSurface,
      host_app:     params.hostApp     || this.defaultHostApp,
      intent_tokens: Array.isArray(params.intentTokens) ? params.intentTokens : undefined,
      active_tools:  Array.isArray(params.activeTools)  ? params.activeTools  : undefined,
    };
    // Strip undefined keys so the wire payload stays clean.
    for (const k of Object.keys(args)) if (args[k] == null) delete args[k];

    const body = { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "get_sponsored_content", arguments: args } };

    const res = await this._fetch(this.endpoint, body);
    const text = res?.result?.content?.[0]?.text;
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : { sponsored: null };
    } catch (e) {
      this._emit("error", { code: "PARSE_ERROR", message: "Failed to parse ad response", detail: e });
      return { sponsored: null };
    }
    // Cache auction context so trackEvent can attach it automatically.
    if (parsed.sponsored && parsed.auction && parsed.sponsored.campaign_id) {
      this._lastAuctionByCampaign.set(String(parsed.sponsored.campaign_id), {
        auction_id:   parsed.auction.auction_id || null,
        placement_id: parsed.auction.placement_id || null,
        surface:      parsed.auction.surface || null,
        format:       parsed.auction.format || null,
        intent_match_score: parsed.auction.intent_match_score != null
          ? Number(parsed.auction.intent_match_score) : null,
      });
    }
    this._emit("ad_response", parsed);
    return parsed;
  }

  /**
   * Report an ad lifecycle event. Impression + click are required for billing.
   *
   * The auction context (auction_id, placement_id, surface, format,
   * intent_match_score) is auto-attached from the last getSponsoredContent
   * call for this campaign, so callers can keep using the simple
   * `trackEvent(event, campaignId)` form. Pass an explicit options object
   * to override per call (useful for multi-ad scenarios).
   *
   * @param {string} event           "impression" | "click" | "close" | "video_complete" | "skip"
   * @param {string} campaignId
   * @param {object} [opts]          Optional overrides
   * @param {string} [opts.auctionId]
   * @param {string} [opts.placementId]
   * @param {string} [opts.surface]
   * @param {string} [opts.format]
   * @param {number} [opts.intentMatchScore]
   */
  async trackEvent(event, campaignId, opts = {}) {
    if (!["impression", "click", "close", "video_complete", "skip"].includes(event)) {
      throw new Error(`Invalid event: ${event}`);
    }
    // Pull cached auction context for this campaign (set by getSponsoredContent),
    // then let explicit opts override.
    const cached = this._lastAuctionByCampaign.get(String(campaignId)) || {};
    const args = {
      event,
      campaign_id: campaignId,
      session_id: this._sessionId,
      developer_api_key: this.apiKey,
      auction_id:   opts.auctionId   || cached.auction_id   || undefined,
      placement_id: opts.placementId || cached.placement_id || undefined,
      surface:      opts.surface     || cached.surface      || undefined,
      format:       opts.format      || cached.format       || undefined,
      intent_match_score: opts.intentMatchScore != null
        ? opts.intentMatchScore
        : (cached.intent_match_score != null ? cached.intent_match_score : undefined),
    };
    for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];

    const body = { jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "track_event", arguments: args } };

    const res = await this._fetch(this.endpoint, body);
    this._emit(event, { campaignId, auction_id: args.auction_id || null });
    return res?.result?.content?.[0]?.text ? JSON.parse(res.result.content[0].text) : { tracked: false };
  }

  _emit(name, payload) {
    if (typeof this.onEvent === "function") {
      try { this.onEvent(name, payload); } catch (e) { /* silent */ }
    }
  }

  async _fetch(url, body) {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const to = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : null;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `boostboss-sdk/${SDK_VERSION}`,
          "X-BB-SDK": SDK_VERSION,
        },
        body: JSON.stringify(body),
        signal: ctl?.signal,
      });
      if (to) clearTimeout(to);
      if (!r.ok) throw new Error(`Boost Boss API ${r.status}`);
      return await r.json();
    } catch (err) {
      if (to) clearTimeout(to);
      // Graceful degrade — never break host app on ad failure
      this._emit("error", { message: err.message });
      return { result: { content: [{ text: JSON.stringify({ sponsored: null, reason: "fetch_failed" }) }] } };
    }
  }
}

// Singleton convenience — most users just want one client
let _default = null;
function _defaultClient() {
  if (!_default) _default = new BoostBoss();
  return _default;
}

module.exports = {
  BoostBoss,
  getSponsoredContent: (params) => _defaultClient().getSponsoredContent(params),
  trackEvent: (event, campaignId) => _defaultClient().trackEvent(event, campaignId),
  configure: (opts) => { _default = new BoostBoss(opts); return _default; },
  SDK_VERSION,
};
