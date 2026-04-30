/**
 * Ad — the rendered-side object returned from fetchAd().
 * Carries the creative payload plus methods for MCP rendering and tracking.
 */
import type { AdPayload, MCPContentBlock } from "./types.js";

export interface AdInternals {
  trackingImpression?: string | null;
  trackingClick?: string | null;
}

export class Ad implements AdPayload {
  readonly adId: string;
  readonly auctionId: string;
  readonly advertiserName?: string;
  readonly headline: string;
  readonly subtext?: string;
  readonly mediaUrl?: string;
  readonly ctaLabel?: string;
  readonly ctaUrl: string;
  readonly disclosureLabel: string;
  readonly intentMatchScore?: number;

  /** @internal */
  private readonly _internals: AdInternals;

  constructor(payload: AdPayload, internals: AdInternals = {}) {
    this.adId            = payload.adId;
    this.auctionId       = payload.auctionId;
    this.advertiserName  = payload.advertiserName;
    this.headline        = payload.headline;
    this.subtext         = payload.subtext;
    this.mediaUrl        = payload.mediaUrl;
    this.ctaLabel        = payload.ctaLabel;
    this.ctaUrl          = payload.ctaUrl;
    this.disclosureLabel = payload.disclosureLabel;
    this.intentMatchScore = payload.intentMatchScore;
    this._internals      = internals;
  }

  /**
   * Format the ad as an MCP content block ready to append to a tool's
   * content array. The disclosure label is baked in — do not strip it.
   */
  toMCPBlock(): MCPContentBlock {
    const lines: string[] = [];
    lines.push(`— ${this.disclosureLabel} —`);
    lines.push(this.headline);
    if (this.subtext) lines.push(this.subtext);
    if (this.ctaLabel || this.ctaUrl) {
      const label = this.ctaLabel || "Learn more";
      lines.push(`${label}: ${this.ctaUrl}`);
    }
    return {
      type: "text",
      text: "\n\n" + lines.join("\n"),
      _meta: {
        boostboss: {
          adId: this.adId,
          auctionId: this.auctionId,
        },
      },
    };
  }

  /**
   * Internal: returns the impression beacon URL the SDK fires on render.
   * Most callers should rely on automatic firing via toMCPBlock(); this
   * is exposed for custom rendering paths.
   */
  getImpressionUrl(): string | null {
    return this._internals.trackingImpression ?? null;
  }

  /** Internal: click beacon URL. The cta_url already redirects through it. */
  getClickUrl(): string | null {
    return this._internals.trackingClick ?? null;
  }
}
