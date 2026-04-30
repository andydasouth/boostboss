/**
 * Lumi — programmatic ad rendering for environments where a <script>
 * tag isn't an option (browser extensions in Manifest v3, Electron /
 * Tauri renderers, frameworks that build their bundle).
 *
 * Same backend as the JS snippet (public/lumi.js); same wire shape.
 * Different surface: this is a class you instantiate and call methods
 * on, instead of a script tag that auto-discovers slots.
 */
import { Client } from "./client.js";
import { TypedEmitter } from "./emitter.js";
import { ERROR_CODES } from "./errors.js";
import {
  injectStyles, renderAd, fireImpressionBeacon, unmountSlot, resetStyles,
} from "./renderer.js";
import type {
  LumiOptions, RenderOptions, AdPayload,
  LumiEventName, LumiHandler,
} from "./types.js";

const VERSION = "0.1.0";
const DEFAULT_API_BASE = "https://boostboss.ai";
const DEFAULT_TIMEOUT_MS = 4000;

interface SlotState {
  el:        HTMLElement;
  format:    string;
  ad:        AdPayload | null;
  backdrop:  HTMLElement | null;
}

export class Lumi {
  static readonly version = VERSION;

  private readonly publisherId: string;
  private readonly client:      Client;
  private readonly emitter      = new TypedEmitter();
  private readonly slots        = new Map<HTMLElement, SlotState>();
  private readonly sessionId:   string;
  private readonly debugEnabled: boolean;
  private destroyed             = false;

  constructor(options: LumiOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Lumi: options object required");
    }
    if (!options.publisherId || typeof options.publisherId !== "string") {
      throw new TypeError("Lumi: 'publisherId' is required (e.g. 'pub_xxx')");
    }
    this.publisherId  = options.publisherId;
    this.debugEnabled = Boolean(options.debug);
    this.sessionId    = "lumi_" + Math.random().toString(36).slice(2, 10) + "_" + Date.now();

    this.client = new Client({
      publisherId: options.publisherId,
      apiBase:     options.apiBase ?? DEFAULT_API_BASE,
      timeoutMs:   options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      source:      "npm-sdk",
    });

    this.emitter.emit("ready", { version: VERSION, sessionId: this.sessionId });
  }

  /**
   * Render an ad into a slot element. Returns the rendered Ad payload
   * (or null on no-fill / error). Never throws.
   */
  async render(target: string | HTMLElement, opts: RenderOptions = {}): Promise<AdPayload | null> {
    if (this.destroyed) return null;
    if (typeof document === "undefined") {
      this.emitter.emit("error", {
        code: ERROR_CODES.NO_DOM,
        message: "Lumi.render() requires a DOM (document is undefined). Use this in a content script or renderer process, not a service worker.",
      });
      return null;
    }

    const el = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
    if (!el) {
      this.emitter.emit("error", {
        code: ERROR_CODES.BAD_REQUEST,
        message: "Lumi.render() target not found: " + String(target),
      });
      return null;
    }
    const format  = opts.format ?? "banner";
    const context = opts.context ?? "";

    // Already mounted? Tear down first so we re-fetch + re-render fresh.
    const existing = this.slots.get(el);
    if (existing) unmountSlot(existing.el, existing.backdrop);

    const resp = await this.client.fetchAd(opts, this.sessionId);
    if (!resp.ok) {
      this.emitter.emit("error", { code: resp.code, message: resp.message });
      return null;
    }
    if (!resp.ad) {
      this.emitter.emit("no_fill", { context, reason: resp.reason ?? null });
      this.slots.set(el, { el, format, ad: null, backdrop: null });
      return null;
    }

    const ad = resp.ad;
    const onClick = () => {
      this.emitter.emit("click", {
        adId: ad.adId, auctionId: ad.auctionId, slot: el,
      });
    };
    const { backdrop } = renderAd(el, ad, format, onClick);
    this.slots.set(el, { el, format, ad, backdrop });

    if (ad.impressionUrl) fireImpressionBeacon(ad.impressionUrl);
    this.emitter.emit("impression", {
      adId:      ad.adId,
      auctionId: ad.auctionId,
      format,
      slot:      el,
      sandbox:   ad.isSandbox,
    });

    if (this.debugEnabled) {
      // eslint-disable-next-line no-console
      console.error("[lumi-sdk] rendered " + format + ":", ad.headline);
    }
    return ad;
  }

  /**
   * Re-fetch and re-render every mounted slot, OR a single slot when a
   * selector / element is passed.
   */
  async refresh(target?: string | HTMLElement): Promise<void> {
    if (this.destroyed) return;
    if (target !== undefined) {
      const el = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
      if (!el) return;
      const existing = this.slots.get(el);
      if (!existing) return;
      await this.render(el, { format: existing.format as RenderOptions["format"] });
      return;
    }
    const entries = [...this.slots.entries()];
    for (const [el, state] of entries) {
      await this.render(el, { format: state.format as RenderOptions["format"] });
    }
  }

  /** Tear down all rendered ads and remove the injected stylesheet. */
  destroy(): void {
    if (this.destroyed) return;
    for (const state of this.slots.values()) {
      unmountSlot(state.el, state.backdrop);
    }
    this.slots.clear();
    if (typeof document !== "undefined") {
      const sty = document.getElementById("lumi-styles");
      if (sty) sty.remove();
    }
    resetStyles();
    this.destroyed = true;
  }

  /** Subscribe to SDK events. */
  on<E extends LumiEventName>(event: E, handler: LumiHandler<E>): void {
    this.emitter.on(event, handler);
  }

  /** Unsubscribe a previously-registered handler. */
  off<E extends LumiEventName>(event: E, handler: LumiHandler<E>): void {
    this.emitter.off(event, handler);
  }

  /** Expose the publisher's session ID for debugging / cross-call correlation. */
  getSessionId(): string { return this.sessionId; }

  /**
   * Pre-warm the SDK's stylesheet without rendering an ad. Useful when
   * you know slots will mount later and want to avoid a layout shift
   * the first time render() runs.
   */
  primeStyles(): void { injectStyles(); }
}
