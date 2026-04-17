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
const SDK_VERSION = "1.0.0";

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
  }

  /**
   * Request a Benna-ranked sponsored ad for the current MCP context.
   *
   * @param {object} params
   * @param {string} params.context   Freeform summary of what the user is doing
   * @param {string} [params.host]    e.g. "cursor.com", "claude.ai", "raycast.com"
   * @param {string} [params.format]  "image" | "video" | "native" | "any"
   * @param {number} [params.sessionLenMin]
   * @returns {Promise<{sponsored: object|null, benna: object}>}
   */
  async getSponsoredContent(params = {}) {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "get_sponsored_content",
        arguments: {
          context_summary: params.context || "",
          host: params.host || null,
          format_preference: params.format || "any",
          user_region: params.region || this.defaultRegion,
          user_language: params.language || this.defaultLanguage,
          session_id: this._sessionId,
          session_len_min: params.sessionLenMin,
          developer_api_key: this.apiKey,
        },
      },
    };
    const res = await this._fetch(this.endpoint, body);
    const text = res?.result?.content?.[0]?.text;
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : { sponsored: null };
    } catch (e) {
      this._emit("error", { code: "PARSE_ERROR", message: "Failed to parse ad response", detail: e });
      return { sponsored: null };
    }
    this._emit("ad_response", parsed);
    return parsed;
  }

  /**
   * Report an ad lifecycle event. Impression + click are required for billing.
   */
  async trackEvent(event, campaignId) {
    if (!["impression", "click", "close", "video_complete", "skip"].includes(event)) {
      throw new Error(`Invalid event: ${event}`);
    }
    const body = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "track_event",
        arguments: {
          event,
          campaign_id: campaignId,
          session_id: this._sessionId,
          developer_api_key: this.apiKey,
        },
      },
    };
    const res = await this._fetch(this.endpoint, body);
    this._emit(event, { campaignId });
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
