/**
 * @boostbossai/lumi-mcp — Boost Boss Lumi SDK for MCP servers.
 *
 * Add three lines to any MCP tool handler. Sponsored content gets appended
 * to your tool's response and rendered natively by the MCP host.
 *
 * Usage (matches https://boostboss.ai/docs/mcp):
 *
 *   import { LumiMCP } from "@boostbossai/lumi-mcp";
 *   const lumi = new LumiMCP({
 *     publisherId: process.env.BBX_PUBLISHER_ID!,
 *     apiKey:      process.env.BBX_API_KEY!,
 *   });
 *
 *   // In a tool handler:
 *   const ad = await lumi.fetchAd({ context: request.params.name });
 *   if (!ad) return { content: result };
 *   return { content: [...result, ad.toMCPBlock()] };
 */

import { Client } from "./client.js";
import { Ad } from "./ad.js";
import { TypedEmitter } from "./emitter.js";
import { ERROR_CODES } from "./errors.js";
import type {
  LumiMCPOptions,
  FetchAdRequest,
  AdPayload,
  LumiEventName,
  LumiHandler,
} from "./types.js";

export type {
  LumiMCPOptions,
  FetchAdRequest,
  AdPayload,
  MCPContentBlock,
  LumiEventName,
  LumiHandler,
  LumiImpressionEvent,
  LumiClickEvent,
  LumiNoFillEvent,
  LumiErrorEvent,
} from "./types.js";
export { Ad } from "./ad.js";
export { ERROR_CODES, type ErrorCode } from "./errors.js";

const DEFAULT_API_BASE = "https://boostboss.ai";
const DEFAULT_TIMEOUT_MS = 2500;

export class LumiMCP {
  private readonly publisherId: string;
  private readonly apiKey: string;
  private readonly client: Client;
  private readonly emitter = new TypedEmitter();
  private readonly debugEnabled: boolean;

  constructor(options: LumiMCPOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("LumiMCP: options object required");
    }
    if (!options.publisherId || typeof options.publisherId !== "string") {
      throw new TypeError("LumiMCP: 'publisherId' is required (e.g. 'pub_xxx')");
    }
    if (!options.apiKey || typeof options.apiKey !== "string") {
      throw new TypeError("LumiMCP: 'apiKey' is required (Bearer token from your dashboard)");
    }

    this.publisherId = options.publisherId;
    this.apiKey = options.apiKey;
    this.debugEnabled = Boolean(options.debug);

    this.client = new Client({
      apiBase: options.apiBase || DEFAULT_API_BASE,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      source: "mcp",
      debug: this.debugEnabled,
    });
  }

  /**
   * Fetch a sponsored content payload contextually matched to opts.context.
   * Returns null on no-fill — callers should still return their primary tool
   * output normally.
   *
   * Never throws on the bid path; failures emit an "error" event and resolve
   * to null so your tool's primary response is never delayed.
   */
  async fetchAd(opts: FetchAdRequest): Promise<Ad | null> {
    const context = (opts && opts.context && String(opts.context).trim()) || "";
    if (!context) {
      this.emitter.emit("error", {
        code: "BBX_BAD_REQUEST",
        message: "fetchAd: 'context' is required and must be non-empty",
      });
      return null;
    }

    const args: Record<string, unknown> = {
      context_summary: context,
      developer_api_key: this.apiKey,
      format_preference: opts.format ?? "native",
    };
    if (opts.toolName)     args.tool_name      = opts.toolName;
    if (opts.userRegion)   args.user_region    = opts.userRegion;
    if (opts.userLanguage) args.user_language  = opts.userLanguage;
    if (opts.sessionId)    args.session_id     = opts.sessionId;
    if (opts.activeTools)  args.active_tools   = opts.activeTools;
    if (opts.hostApp)      args.host_app       = opts.hostApp;

    const resp = await this.client.callTool<unknown>("get_sponsored_content", args);
    if (!resp.ok) {
      this.emitter.emit("error", { code: resp.code, message: resp.message });
      return null;
    }

    // The MCP tool result is { content: [{ type: 'text', text: <JSON string> }] }.
    // Unwrap to the payload we actually care about.
    const payload = unwrapToolText<{
      sponsored: SponsoredWire | null;
      auction?: AuctionWire;
      reason?: string;
      auction_id?: string;
    }>(resp.value);

    if (!payload || !payload.sponsored) {
      this.emitter.emit("no_fill", { context });
      return null;
    }

    const ad = adFromWire(payload.sponsored, payload.auction);
    this.emitter.emit("impression", {
      adId: ad.adId,
      auctionId: ad.auctionId,
      advertiserId: payload.sponsored.advertiser_id,
      cpm: payload.auction?.winning_price_cpm,
    });

    // Fire the impression beacon — fire-and-forget, never await.
    if (payload.sponsored.tracking?.impression) {
      void fireBeacon(payload.sponsored.tracking.impression).catch(() => {});
    }

    return ad;
  }

  /** Fire the impression beacon manually. Only needed for custom rendering paths. */
  async trackImpression(ad: Ad): Promise<void> {
    const url = ad.getImpressionUrl();
    if (!url) return;
    await fireBeacon(url).catch(() => {});
  }

  /** Fire the click beacon manually. The cta_url already redirects through it. */
  async trackClick(ad: Ad): Promise<void> {
    const url = ad.getClickUrl();
    if (!url) return;
    this.emitter.emit("click", { adId: ad.adId, auctionId: ad.auctionId });
    await fireBeacon(url).catch(() => {});
  }

  /** Subscribe to SDK events: 'impression', 'click', 'no_fill', 'error'. */
  on<E extends LumiEventName>(event: E, handler: LumiHandler<E>): void {
    this.emitter.on(event, handler);
  }

  /** Unsubscribe a previously-registered handler. */
  off<E extends LumiEventName>(event: E, handler: LumiHandler<E>): void {
    this.emitter.off(event, handler);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────

interface SponsoredWire {
  campaign_id: string;
  advertiser_id?: string;
  type?: string;
  headline: string;
  subtext?: string;
  media_url?: string;
  poster_url?: string | null;
  cta_label?: string;
  cta_url: string;
  disclosure_label?: string;
  tracking?: {
    impression?: string;
    click?: string;
    close?: string;
    video_complete?: string;
  };
}

interface AuctionWire {
  auction_id: string;
  winning_price_cpm?: number;
  intent_match_score?: number;
  surface?: string;
  format?: string;
}

function unwrapToolText<T>(raw: unknown): T | null {
  // MCP tool results: { content: [ { type: 'text', text: '<json>' } ] }
  const r = raw as { content?: Array<{ type?: string; text?: string }> } | null;
  const block = r?.content?.[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") return null;
  try {
    return JSON.parse(block.text) as T;
  } catch (_e) {
    return null;
  }
}

function adFromWire(s: SponsoredWire, a?: AuctionWire): Ad {
  const auctionId = a?.auction_id ?? "";
  return new Ad(
    {
      adId:            s.campaign_id,
      auctionId,
      advertiserName:  undefined, // backend does not currently surface; reserved
      headline:        s.headline,
      subtext:         s.subtext,
      mediaUrl:        s.media_url,
      ctaLabel:        s.cta_label,
      ctaUrl:          s.cta_url,
      disclosureLabel: s.disclosure_label || "Sponsored",
      intentMatchScore: a?.intent_match_score,
    },
    {
      trackingImpression: s.tracking?.impression ?? null,
      trackingClick:      s.tracking?.click ?? null,
    },
  );
}

async function fireBeacon(url: string): Promise<void> {
  // Beacons are GET requests; backend doesn't care about the body.
  await fetch(url, { method: "GET" });
}
