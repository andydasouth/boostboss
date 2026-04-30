/**
 * Public type definitions for @boostbossai/lumi-mcp.
 * Mirrors what /docs/mcp documents.
 */

export interface LumiMCPOptions {
  /** Publisher ID from your dashboard (e.g. `pub_xxx`). */
  publisherId: string;
  /** Bearer token from your dashboard. Server-side only — never embed in client code. */
  apiKey: string;
  /** Auto-detected from your MCP server config; override only if needed. */
  transport?: "stdio" | "http";
  /** Logs every fetchAd call and response to stderr. Default: false. */
  debug?: boolean;
  /** Network timeout per request in ms. Default: 2500. */
  timeoutMs?: number;
  /** Override the Boost Boss API base URL. Used for sandbox / staging / self-hosted. */
  apiBase?: string;
}

export interface FetchAdRequest {
  /** Free-form text describing what the user is doing. Used for contextual matching. */
  context: string;
  /** Preferred ad format. Default: "native". */
  format?: "native" | "banner" | "inline";
  /** Name of the MCP tool being called. Improves analytics. */
  toolName?: string;
  /** ISO region (US, EU, APAC). If omitted, inferred server-side. */
  userRegion?: string;
  /** ISO language code. Default: "en". */
  userLanguage?: string;
  /** Stable per-end-user-session identifier (used for frequency capping). */
  sessionId?: string;
  /** Active MCP tools in the host (helps targeting). */
  activeTools?: string[];
  /** Host application identifier (e.g. "claude_desktop", "cursor"). */
  hostApp?: string;
}

export interface AdPayload {
  /** Server-issued ad identifier; pass to track* methods if you build custom tracking. */
  adId: string;
  /** Auction identifier; idempotency key for impression/click tracking. */
  auctionId: string;
  /** Advertiser display name. */
  advertiserName?: string;
  /** Headline string. */
  headline: string;
  /** Body / subtext. */
  subtext?: string;
  /** Image URL if the ad is image-format. */
  mediaUrl?: string;
  /** Call-to-action label. */
  ctaLabel?: string;
  /** Click-through URL — already a tracking redirect. */
  ctaUrl: string;
  /** Required disclosure label (e.g. "Sponsored"). Locale-aware. */
  disclosureLabel: string;
  /** Server-supplied benna intent-match score, if available. */
  intentMatchScore?: number;
}

/**
 * MCP host content blocks have a structured `type`. We render as a
 * single text block with the disclosure baked in — most hosts collapse
 * adjacent text blocks, so a single block is the safest default.
 */
export interface MCPContentBlock {
  type: "text";
  text: string;
  _meta?: {
    boostboss?: {
      adId: string;
      auctionId: string;
    };
  };
}

export type LumiEventName = "impression" | "click" | "no_fill" | "error";

export interface LumiImpressionEvent {
  adId: string;
  auctionId: string;
  advertiserId?: string;
  cpm?: number;
}
export interface LumiClickEvent {
  adId: string;
  auctionId: string;
}
export interface LumiNoFillEvent {
  context: string;
}
export interface LumiErrorEvent {
  /** Stable error code, e.g. BBX_AUTH, BBX_RATE_LIMIT, BBX_TIMEOUT. */
  code: string;
  /** Human-readable message. */
  message: string;
}

export type LumiEventPayload<E extends LumiEventName> =
  E extends "impression" ? LumiImpressionEvent :
  E extends "click"      ? LumiClickEvent :
  E extends "no_fill"    ? LumiNoFillEvent :
  E extends "error"      ? LumiErrorEvent :
  never;

export type LumiHandler<E extends LumiEventName> = (event: LumiEventPayload<E>) => void;
