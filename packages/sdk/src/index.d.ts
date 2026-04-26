// Type definitions for @boostbossai/lumi-sdk

export type Surface =
  | "chat"
  | "tool_response"
  | "sidebar"
  | "loading_screen"
  | "status_line"
  | "web";

export type AdFormat = "image" | "video" | "native" | "text_card";

export interface BennaPriceFactors {
  advertiser_bid_cpm: number;
  baseline_ctr: number;
  geo_multiplier: number;
  format_multiplier: number;
  intent_match_score: number;
  safety_multiplier: number;
  floor_cpm: number;
}

export interface BennaAttribution {
  model_version: string;
  bid_usd: number;
  effective_bid_usd: number;
  p_click: number;
  p_convert: number;
  signal_contributions: Record<string, number> | Array<{ signal: string; weight: number; lift: number }>;
  latency_ms: number;
  candidates_considered: number;
  context: Record<string, string | number>;
  price_cpm?: number;
  cleared_floor?: boolean;
  mcp_targeting?: {
    surface?: string | null;
    host_app?: string | null;
    active_tools?: string[];
    intent_tokens?: string[];
  };
  self_promote?: boolean;
}

export interface AuctionMetadata {
  auction_id: string;
  placement_id: string | null;
  surface: Surface | null;
  format: AdFormat | null;
  floor_cpm: number | null;
  winning_price_cpm: number;
  intent_match_score: number;
  candidates_considered: number;
  price_breakdown?: BennaPriceFactors;
}

export interface SponsoredAd {
  campaign_id: string;
  type: AdFormat;
  headline: string;
  subtext: string;
  media_url: string;
  poster_url?: string | null;
  cta_label: string;
  cta_url: string;
  skippable_after_sec: number;
  tracking: {
    impression: string;
    click: string;
    close: string;
    video_complete: string;
  };
}

export interface AdResponse {
  sponsored: SponsoredAd | null;
  reason?: string;
  auction?: AuctionMetadata;
  benna?: BennaAttribution;
}

export interface BoostBossOptions {
  apiKey?: string;
  endpoint?: string;
  region?: string;
  language?: string;
  timeoutMs?: number;
  sessionId?: string;
  onEvent?: (name: string, payload: unknown) => void;
  /** Default placement_id applied to every getSponsoredContent call. */
  placementId?: string;
  /** Default UI surface for this SDK instance. */
  surface?: Surface;
  /** Default canonical host app: "cursor" | "claude_desktop" | "vscode" | "jetbrains" */
  hostApp?: string;
}

export interface GetSponsoredParams {
  context: string;
  host?: string;
  hostApp?: string;
  format?: AdFormat | "any";
  sessionLenMin?: number;
  region?: string;
  language?: string;
  /** Publisher placement_id. Recommended — enables floor + freq cap + reporting. */
  placementId?: string;
  surface?: Surface;
  /** Free-form intent strings (e.g. ["billing_integration","stripe","saas"]). */
  intentTokens?: string[];
  /** Canonical names of MCP servers connected (e.g. ["stripe-mcp","quickbooks-mcp"]). */
  activeTools?: string[];
}

export type AdEvent = "impression" | "click" | "close" | "video_complete" | "skip";

export interface TrackEventOptions {
  auctionId?: string;
  placementId?: string;
  surface?: Surface;
  format?: AdFormat;
  intentMatchScore?: number;
}

export interface TrackResult {
  tracked: boolean;
  deduplicated?: boolean;
  auction_id?: string | null;
  campaign_id?: string;
  error?: string;
}

export class BoostBoss {
  constructor(opts?: BoostBossOptions);
  getSponsoredContent(params: GetSponsoredParams): Promise<AdResponse>;
  trackEvent(event: AdEvent, campaignId: string, opts?: TrackEventOptions): Promise<TrackResult>;
}

export function getSponsoredContent(params: GetSponsoredParams): Promise<AdResponse>;
export function trackEvent(event: AdEvent, campaignId: string, opts?: TrackEventOptions): Promise<TrackResult>;
export function configure(opts: BoostBossOptions): BoostBoss;
export const SDK_VERSION: string;
