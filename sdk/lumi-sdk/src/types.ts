/**
 * Public type definitions for @boostbossai/lumi-sdk.
 * Mirrors what /docs/npm-sdk documents.
 */

export interface LumiOptions {
  /** Public publisher ID (e.g. `pub_xxx`). Sandbox: `pub_test_*`. */
  publisherId: string;
  /** Override the Boost Boss API base. Used for sandbox / staging. */
  apiBase?: string;
  /** Log every fetch + render to console.error. Default: false. */
  debug?: boolean;
  /** Network timeout per ad request in ms. Default: 4000. */
  timeoutMs?: number;
}

export interface RenderOptions {
  /** Layout format. Determines visual treatment. */
  format?: "banner" | "sidebar" | "inline" | "interstitial";
  /** Free-form intent string used for contextual matching. */
  context?: string;
  /** Stable per-session identifier for frequency capping. */
  sessionId?: string;
  /** ISO language code. Default inferred from navigator.language. */
  userLanguage?: string;
  /** ISO region (US/EU/APAC). Default inferred server-side. */
  userRegion?: string;
  /** Host application identifier (e.g. "browser_extension", "electron"). */
  hostApp?: string;
  /** UI surface (e.g. "sidepanel", "content_script", "popup"). */
  surface?: string;
}

export interface AdPayload {
  adId:            string;
  auctionId:       string | null;
  type:            string;
  headline:        string;
  body:            string;
  mediaUrl:        string | null;
  ctaLabel:        string;
  ctaUrl:          string;
  impressionUrl:   string | null;
  disclosureLabel: string;
  isSandbox:       boolean;
}

export type LumiEventName = "impression" | "click" | "close" | "no_fill" | "error" | "ready";

export interface LumiImpressionEvent {
  adId:       string;
  auctionId:  string | null;
  format:     string;
  slot?:      Element | null;
  sandbox:    boolean;
}
export interface LumiClickEvent {
  adId:      string;
  auctionId: string | null;
  slot?:     Element | null;
}
export interface LumiCloseEvent {
  adId:      string;
  auctionId: string | null;
}
export interface LumiNoFillEvent {
  context: string;
  reason?: string | null;
}
export interface LumiErrorEvent {
  code:    string;
  message: string;
  detail?: unknown;
}
export interface LumiReadyEvent {
  version: string;
  sessionId: string;
}

export type LumiEventPayload<E extends LumiEventName> =
  E extends "impression" ? LumiImpressionEvent :
  E extends "click"      ? LumiClickEvent :
  E extends "close"      ? LumiCloseEvent :
  E extends "no_fill"    ? LumiNoFillEvent :
  E extends "error"      ? LumiErrorEvent :
  E extends "ready"      ? LumiReadyEvent :
  never;

export type LumiHandler<E extends LumiEventName> = (event: LumiEventPayload<E>) => void;
