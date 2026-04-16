// Type definitions for @boostboss/sdk

export interface BennaAttribution {
  model_version: string;
  bid_usd: number;
  effective_bid_usd: number;
  p_click: number;
  p_convert: number;
  signal_contributions: Record<string, number>;
  latency_ms: number;
  candidates_considered: number;
  context: Record<string, string | number>;
}

export interface SponsoredAd {
  campaign_id: string;
  type: "image" | "video" | "native";
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
}

export interface GetSponsoredParams {
  context: string;
  host?: string;
  format?: "image" | "video" | "native" | "any";
  sessionLenMin?: number;
  region?: string;
  language?: string;
}

export type AdEvent = "impression" | "click" | "close" | "video_complete" | "skip";

export class BoostBoss {
  constructor(opts?: BoostBossOptions);
  getSponsoredContent(params: GetSponsoredParams): Promise<AdResponse>;
  trackEvent(event: AdEvent, campaignId: string): Promise<{ tracked: boolean }>;
}

export function getSponsoredContent(params: GetSponsoredParams): Promise<AdResponse>;
export function trackEvent(event: AdEvent, campaignId: string): Promise<{ tracked: boolean }>;
export function configure(opts: BoostBossOptions): BoostBoss;
export const SDK_VERSION: string;
