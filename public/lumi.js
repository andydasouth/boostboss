/**
 * @boostbossai/lumi · JS Snippet for AI app monetization
 *
 * Drop-in browser script that auto-discovers `[data-lumi-slot]` elements,
 * fetches contextually-matched sponsored content from Boost Boss, and
 * renders inside the slot. Same backend as @boostbossai/lumi-mcp; this is
 * the web-surface door of the same ad network.
 *
 * Usage (matches https://boostboss.ai/docs/js-snippet):
 *
 *   <script async
 *     src="https://boostboss.ai/lumi.js"
 *     data-publisher-id="pub_xxx"></script>
 *
 *   <div data-lumi-slot="card"></div>
 *   <div data-lumi-slot="citation" data-lumi-context="checkout flow"></div>
 *
 * Slot types (the five placements the Web door owns):
 *   corner    Corner / sticky anchored unit. Renders fixed to a screen corner.
 *   card      Inline sponsored card. Renders in the slot.
 *   loading   Loading / "thinking"-state ad. Renders in the slot; remove the
 *             slot element when your AI response is ready.
 *   citation  Sponsored source / citation. Compact, inline.
 *   chip      Sponsored suggested-action chip. A tappable pill.
 *   (legacy banner/sidebar/inline/interstitial still resolve — see normalizeFormat)
 *
 * Sandbox: data-publisher-id="pub_test_demo" returns a fixed test creative.
 *
 * Events dispatched on window:
 *   lumi:ready        — SDK booted
 *   lumi:impression   — slot rendered an ad
 *   lumi:click        — user clicked CTA
 *   lumi:close        — user dismissed (corner / card)
 *   lumi:no_fill      — slot stayed empty
 *   lumi:error        — request or parse error; see e.detail.code
 *
 * Every impression / click / dismiss also fires a server-side tracking
 * beacon. Those beacon URLs carry the context fingerprint (ctx=) minted by
 * the auction, so feedback is context-joined end to end.
 *
 * Programmatic API:
 *   Lumi.refresh(selector?)  — re-fetch + re-render. No arg refreshes all.
 *   Lumi.destroy()           — tear down all rendered ads + observers.
 *   Lumi.render(el, opts)    — manual mount for a slot not auto-discovered.
 *   Lumi.show(format, opts)  — create + mount an ad from code (e.g. an
 *                              interstitial/video overlay). Returns the element.
 *   Lumi.on(event, handler)  — subscribe to lifecycle events; returns unsub fn.
 *   Lumi.trackConversion(o)  — fire a publisher-side conversion event.
 *   Lumi.getLastError()      — last error object or null.
 *   Lumi.setDebug(bool)      — toggle debug logging at runtime.
 *   Lumi.version             — semver string.
 */

(function (window, document) {
  "use strict";

  if (window.Lumi && window.Lumi.__loaded) return;     // idempotent

  // ── Config ─────────────────────────────────────────────────────────
  const VERSION    = "0.2.0";
  const SESSION_ID = "lumi_" + Math.random().toString(36).slice(2, 12) + "_" + Date.now();
  const DEFAULT_API_BASE = "https://boostboss.ai";

  const script = document.currentScript ||
    document.querySelector('script[src*="lumi.js"]');
  let publisherId = script ? script.getAttribute("data-publisher-id") : null;
  let apiBase     = (script && script.getAttribute("data-api-base")) || DEFAULT_API_BASE;
  let debug       = script && script.getAttribute("data-debug") === "true";

  // ── State ──────────────────────────────────────────────────────────
  const slots      = new Map();   // element -> { ad, format, context, mounted, frequency, observed }
  let lastError    = null;
  let cssInjected  = false;
  let observer     = null;
  let initialized  = false;

  // ── Placement taxonomy ─────────────────────────────────────────────
  // The five placements the Web door owns. Legacy slot names from the
  // pre-matrix taxonomy still resolve so existing integrations don't break.
  // Core render formats lumi.js paints natively. 2026-07 audit closed the gap:
  // image (banner/native-image), interstitial (full-page overlay), and video
  // (pre-roll + rewarded) are now real renderers, so every one of the 37
  // placements resolves to a true render path on the web door.
  const CORE_FORMATS   = ["corner", "card", "loading", "citation", "chip",
                          "image", "interstitial", "video", "rewarded"];
  // Alias map — surface/marketing slot names → a core render format.
  const LEGACY_FORMATS = {
    banner: "image", sidebar: "card", inline: "citation",
    native_banner: "image", bottom_banner: "image", "bottom-banner": "image",
    takeover: "interstitial", newtab: "interstitial", "new-tab": "interstitial",
    splash: "interstitial", "splash-sponsor": "interstitial",
    preroll: "video", "pre-roll": "video", pre_roll: "video",
    rewarded_video: "rewarded", "rewarded-video": "rewarded",
  };
  // What creative the server should price/serve for each render format.
  const FORMAT_PREF    = {
    corner: "corner", card: "native", loading: "native", citation: "native", chip: "native",
    image: "image", interstitial: "image", video: "video", rewarded: "video",
  };
  function normalizeFormat(raw) {
    const f = String(raw || "").toLowerCase().trim();
    if (CORE_FORMATS.indexOf(f) >= 0) return f;
    return LEGACY_FORMATS[f] || "card";
  }

  // ── Logging ────────────────────────────────────────────────────────
  function log(msg, ...args) {
    if (debug) console.log("[lumi]", msg, ...args);
  }
  function emitError(code, message, detail) {
    lastError = { code, message, detail: detail || null, ts: Date.now() };
    if (debug) console.warn("[lumi] " + code + ": " + message, detail || "");
    dispatch("error", lastError);
  }

  // ── Events ─────────────────────────────────────────────────────────
  function dispatch(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent("lumi:" + name, { detail }));
    } catch (_e) { /* SSR or sandboxed envs */ }
  }

  // ── Inject styles once ─────────────────────────────────────────────
  function injectStyles() {
    if (cssInjected) return;
    cssInjected = true;
    const style = document.createElement("style");
    style.id = "lumi-styles";
    style.textContent = `
.lumi-corner, .lumi-cardbox, .lumi-loading, .lumi-citation, .lumi-chip {
  --_p:   var(--lumi-primary, #FF2D78);
  --_t:   var(--lumi-text, #0F0F1A);
  --_m:   var(--lumi-muted, #6B7280);
  --_bg:  var(--lumi-bg, #FFFFFF);
  --_b:   var(--lumi-border, #E5E7EB);
  --_r:   var(--lumi-radius, 12px);
  --_f:   var(--lumi-font, -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif);
  font-family: var(--_f);
  color: var(--_t);
  box-sizing: border-box;
}
.lumi-disclosure {
  display: inline-block; font-size: 11px; font-weight: 600;
  color: var(--_m); letter-spacing: 0.04em; text-transform: uppercase;
}
/* ── brand line (Creatives library brand_kit) ── */
.lumi-brand {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 11px; color: var(--_m); line-height: 1.2;
}
.lumi-brand__logo {
  width: 18px; height: 18px; border-radius: 4px; object-fit: contain;
  background: #fff; flex-shrink: 0;
}
.lumi-brand__name { font-weight: 700; color: var(--_t); }
.lumi-brand__domain, .lumi-brand__dot { color: var(--_m); }
/* ── voucher endcard (Creatives library voucher) ── */
.lumi-voucher {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 8px 11px; background: rgba(255, 247, 237, 0.85);
  border: 1px solid rgba(252, 211, 77, 0.55); border-radius: 8px;
}
.lumi-voucher__icon { font-size: 16px; line-height: 1; flex-shrink: 0; }
.lumi-voucher__body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.lumi-voucher__value { font-size: 12px; font-weight: 700; color: #92400E; line-height: 1.3; }
.lumi-voucher__code { font-size: 10.5px; color: #9A3412;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: 0.04em; }
.lumi-cta {
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--_p); color: #fff; font-weight: 600; font-size: 13px;
  padding: 8px 16px; border-radius: 8px; text-decoration: none; line-height: 1.2;
  transition: filter 0.15s; white-space: nowrap;
}
.lumi-cta:hover { filter: brightness(1.08); }
.lumi-x {
  position: absolute; top: 8px; right: 10px;
  width: 24px; height: 24px; border: none; background: transparent;
  cursor: pointer; font-size: 18px; line-height: 1; color: var(--_m); padding: 0;
}
.lumi-x:hover { color: var(--_t); }

/* ── Save to affiliate — sits next to the close X in the top-right
   action cluster. Originally placed top-left, but the .lumi-disclosure
   ("SPONSORED · …") label always occupies that area, so the bookmark
   got obscured. Grouping the two action icons (save + close) in the
   same corner is also a more conventional pattern. ── */
.lumi-save {
  position: absolute; top: 8px; right: 38px;
  width: 24px; height: 24px; border: none; background: transparent;
  cursor: pointer; line-height: 1; color: var(--_m); padding: 0;
  display: flex; align-items: center; justify-content: center;
}
.lumi-save svg { width: 15px; height: 15px; display: block; fill: currentColor; }
.lumi-save:hover    { color: var(--_p); }
.lumi-save.is-saved { color: var(--_p); }

.lumi-save-pop {
  position: absolute; top: 36px; right: 8px; z-index: 10;
  background: #fff; border: 1px solid var(--_b); border-radius: 10px;
  padding: 14px 14px 12px; min-width: 220px; max-width: 280px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.14);
  font-family: inherit; font-size: 13px; color: var(--_t);
  line-height: 1.5; text-align: left;
}
.lumi-save-pop__title { font-weight: 700; font-size: 13.5px; margin-bottom: 6px; color: var(--_t); }
.lumi-save-pop__sub   { font-size: 12px; color: var(--_m); margin-bottom: 12px; line-height: 1.5; }
.lumi-save-pop__err   { font-size: 12px; color: #DC2626; margin-bottom: 8px; display: none; line-height: 1.4; }
.lumi-save-pop__err.is-show { display: block; }
.lumi-save-pop__row   { display: flex; gap: 6px; }
.lumi-save-pop__btn   {
  flex: 1; padding: 8px 10px; border: 1px solid var(--_b); border-radius: 7px;
  background: #fff; color: var(--_t); cursor: pointer; font-size: 12.5px;
  font-weight: 600; font-family: inherit;
}
.lumi-save-pop__btn:hover { background: rgba(0,0,0,0.03); }
.lumi-save-pop__btn--primary { background: var(--_p); color: #fff !important; border-color: var(--_p); }
.lumi-save-pop__btn--primary:hover { filter: brightness(1.06); background: var(--_p); }
.lumi-save-pop__btn:disabled { opacity: 0.55; cursor: not-allowed; }
.lumi-save-pop__field { margin-bottom: 7px; }
.lumi-save-pop__field input {
  width: 100%; padding: 7px 9px; border: 1px solid var(--_b);
  border-radius: 6px; font-size: 12.5px; font-family: inherit; color: var(--_t);
  background: #fff; box-sizing: border-box;
}
.lumi-save-pop__field input:focus { outline: none; border-color: var(--_p); box-shadow: 0 0 0 2px rgba(255,45,120,0.10); }
.lumi-save-pop__done { text-align: center; padding: 4px 0 2px; }
.lumi-save-pop__done .check { font-size: 22px; color: #16A34A; margin-bottom: 4px; line-height: 1; }
.lumi-save-pop__foot {
  font-size: 11px; color: var(--_m); margin-top: 10px; padding-top: 8px;
  border-top: 1px solid var(--_b); text-align: center;
}
.lumi-save-pop__foot a { color: var(--_p); font-weight: 600; text-decoration: none; }
.lumi-save-pop__foot a:hover { text-decoration: underline; }

/* ── card — inline sponsored card ── */
.lumi-cardbox {
  position: relative; display: flex; flex-direction: column; gap: 8px;
  padding: 14px 16px; background: var(--_bg);
  border: 1px solid var(--_b); border-left: 3px solid var(--_p);
  border-radius: var(--_r); max-width: 540px;
}
.lumi-cardbox__media { width: 100%; aspect-ratio: 16/9; object-fit: cover; border-radius: 8px; }
.lumi-cardbox__title { font-size: 15px; font-weight: 700; line-height: 1.3; margin: 0; }
.lumi-cardbox__sub   { font-size: 13px; color: var(--_m); line-height: 1.45; margin: 0; }
.lumi-cardbox__cta   { align-self: flex-start; }

/* ── corner — sticky anchored unit ── */
.lumi-corner-anchor { position: fixed; bottom: 24px; right: 24px; width: 320px; z-index: 2147483646; }
.lumi-corner {
  position: relative; display: flex; flex-direction: column; gap: 8px;
  padding: 16px; background: var(--_bg);
  border: 1px solid var(--_b); border-radius: var(--_r);
  box-shadow: 0 16px 48px rgba(0,0,0,0.22);
}
.lumi-corner__media { width: 100%; aspect-ratio: 16/9; object-fit: cover; border-radius: 8px; }
.lumi-corner__title { font-size: 15px; font-weight: 700; line-height: 1.3; margin: 0; }
.lumi-corner__sub   { font-size: 13px; color: var(--_m); line-height: 1.45; margin: 0; }
.lumi-corner__cta   { align-self: stretch; }

/* ── loading — "thinking"-state ad ── */
.lumi-loading {
  position: relative; overflow: hidden;
  padding: 13px 16px; background: var(--_bg);
  border: 1px solid var(--_b); border-radius: var(--_r); max-width: 540px;
}
.lumi-loading::after {
  content: ''; position: absolute; top: 0; left: -40%; width: 40%; height: 100%;
  background: linear-gradient(90deg, transparent, rgba(0,0,0,0.045), transparent);
  animation: lumi-shim 1.4s infinite;
}
.lumi-loading__title { font-size: 13px; font-weight: 700; margin: 6px 0 3px; }
.lumi-loading__sub   { font-size: 12px; color: var(--_m); margin: 0 0 8px; }
.lumi-loading__cta   { color: var(--_p); font-weight: 600; text-decoration: none; font-size: 12px; }
.lumi-loading__cta:hover { text-decoration: underline; }
@keyframes lumi-shim { to { left: 120%; } }

/* ── citation — sponsored source ── */
.lumi-citation { font-size: 13px; line-height: 1.5; }
.lumi-citation__title { font-weight: 600; }
.lumi-citation__cta {
  color: var(--_p); font-weight: 600; text-decoration: none; margin-left: 4px;
}
.lumi-citation__cta:hover { text-decoration: underline; }

/* ── chip — suggested-action pill ── */
.lumi-chip {
  display: inline-flex; align-items: center; gap: 7px;
  background: var(--_bg); border: 1px solid var(--_p); border-radius: 999px;
  padding: 7px 14px; margin: 4px 6px 4px 0;
  font-size: 12px; font-weight: 600; color: var(--_t);
  text-decoration: none; cursor: pointer; transition: background 0.15s;
}
.lumi-chip:hover { background: rgba(255,45,120,0.07); }
.lumi-chip__dot  { width: 6px; height: 6px; border-radius: 50%; background: var(--_p); flex-shrink: 0; }
.lumi-chip__tag  { font-size: 9px; color: var(--_m); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }

@media (max-width: 480px) {
  .lumi-corner-anchor { left: 12px; right: 12px; width: auto; }
}

/* ── image — real banner/native-image ad ── */
.lumi-image {
  --_p: var(--lumi-primary, #FF2D78); --_m: var(--lumi-muted, #6B7280);
  --_b: var(--lumi-border, #E5E7EB); --_r: var(--lumi-radius, 12px);
  position: relative; display: block; border: 1px solid var(--_b);
  border-radius: var(--_r); overflow: hidden; text-decoration: none;
  font-family: var(--lumi-font, -apple-system, BlinkMacSystemFont, "Inter", sans-serif);
}
.lumi-image__img { display: block; width: 100%; height: auto; }
.lumi-image__tag {
  position: absolute; top: 8px; left: 8px; font-size: 9px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.05em; color: #fff;
  background: rgba(0,0,0,0.55); padding: 3px 7px; border-radius: 6px;
}
.lumi-image__cap {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 9px 12px; background: var(--lumi-bg, #fff);
}
.lumi-image__h { font-size: 13px; font-weight: 600; color: var(--lumi-text,#0F0F1A); margin: 0; }

/* ── interstitial / takeover — full-page overlay ── */
.lumi-inter-backdrop {
  position: fixed; inset: 0; z-index: 2147482000; display: flex;
  align-items: center; justify-content: center; padding: 20px;
  background: rgba(6,6,12,0.72); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
  font-family: var(--lumi-font, -apple-system, BlinkMacSystemFont, "Inter", sans-serif);
}
.lumi-inter {
  position: relative; width: 100%; max-width: 460px; background: var(--lumi-bg,#fff);
  border-radius: 16px; overflow: hidden; box-shadow: 0 24px 70px rgba(0,0,0,0.5);
}
.lumi-inter__img { display: block; width: 100%; height: auto; max-height: 60vh; object-fit: cover; }
.lumi-inter__body { padding: 18px 20px 20px; }
.lumi-inter__h { font-size: 19px; font-weight: 700; color: var(--lumi-text,#0F0F1A); margin: 0 0 6px; }
.lumi-inter__sub { font-size: 14px; color: var(--lumi-muted,#6B7280); margin: 0 0 16px; line-height: 1.5; }
.lumi-inter__x {
  position: absolute; top: 10px; right: 12px; width: 30px; height: 30px; z-index: 2;
  border: none; border-radius: 50%; background: rgba(0,0,0,0.45); color: #fff;
  font-size: 18px; line-height: 1; cursor: pointer;
}
.lumi-inter__x[disabled] { opacity: 0.5; cursor: default; }

/* ── video — pre-roll + rewarded ── */
.lumi-video-backdrop {
  position: fixed; inset: 0; z-index: 2147482000; display: flex;
  align-items: center; justify-content: center; padding: 16px;
  background: rgba(0,0,0,0.9);
  font-family: var(--lumi-font, -apple-system, BlinkMacSystemFont, "Inter", sans-serif);
}
.lumi-video-wrap { position: relative; width: 100%; max-width: 720px; }
.lumi-video-wrap video { display: block; width: 100%; border-radius: 10px; background: #000; }
.lumi-video__skip {
  position: absolute; bottom: 14px; right: 14px; z-index: 2;
  background: rgba(0,0,0,0.65); color: #fff; border: 1px solid rgba(255,255,255,0.3);
  border-radius: 8px; padding: 7px 13px; font-size: 13px; font-weight: 600; cursor: pointer;
}
.lumi-video__skip[disabled] { opacity: 0.6; cursor: default; }
.lumi-video__optin {
  width: 100%; max-width: 420px; background: var(--lumi-bg,#fff); border-radius: 16px;
  padding: 24px; text-align: center; box-shadow: 0 24px 70px rgba(0,0,0,0.5);
}
.lumi-video__optin h3 { margin: 0 0 6px; font-size: 18px; color: var(--lumi-text,#0F0F1A); }
.lumi-video__optin p { margin: 0 0 18px; font-size: 14px; color: var(--lumi-muted,#6B7280); }
.lumi-video__endcard {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 12px; text-align: center;
  background: rgba(8,8,14,0.82); border-radius: 10px; padding: 24px; color: #fff;
}
.lumi-video__endcard h3 { margin: 0; font-size: 20px; }
    `;
    document.head.appendChild(style);
  }

  // ── Backend call ───────────────────────────────────────────────────
  async function fetchAd(opts) {
    if (!publisherId) {
      emitError("BBX_NO_PUBLISHER_ID", "data-publisher-id missing on script tag");
      return null;
    }
    const context = (opts.context || "").trim();
    if (!context) {
      emitError("BBX_BAD_REQUEST", "context required for fetchAd");
      return null;
    }
    const format = opts.format || "card";

    const body = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "get_sponsored_content",
        arguments: {
          context_summary: context,
          format_preference: FORMAT_PREF[format] || "native",
          session_id: SESSION_ID,
          // Snippet uses publisher_id as the public identifier; backend
          // also accepts it under developer_api_key for sandbox prefix
          // detection (api/_lib/sandbox.js). Same value either way.
          developer_api_key: publisherId,
          publisher_id:      publisherId,
          user_language:     navigator.language ? navigator.language.split("-")[0] : "en",
          host_app:          "web",
          surface:           "web-" + format,
        },
      },
    };

    let resp;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      resp = await fetch(apiBase.replace(/\/$/, "") + "/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Lumi-Source": "js-snippet",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
    } catch (e) {
      emitError(e.name === "AbortError" ? "BBX_TIMEOUT" : "BBX_NETWORK",
        e.message || "network error", { name: e.name });
      return null;
    }

    if (!resp.ok) {
      emitError("BBX_HTTP_" + resp.status, "backend returned HTTP " + resp.status);
      return null;
    }

    let json;
    try { json = await resp.json(); } catch (_e) {
      emitError("BBX_BAD_RESPONSE", "invalid JSON in response");
      return null;
    }

    const txt = json && json.result && json.result.content && json.result.content[0] && json.result.content[0].text;
    if (!txt) {
      emitError("BBX_BAD_RESPONSE", "empty result content");
      return null;
    }
    let payload;
    try { payload = JSON.parse(txt); } catch (_e) {
      emitError("BBX_BAD_RESPONSE", "result text not JSON");
      return null;
    }

    if (!payload.sponsored) {
      dispatch("no_fill", { context, reason: payload.reason || null });
      return null;
    }

    // brand_kit + voucher arrived in the wire 2026-06-25 alongside the
    // global Creatives library. Hydrate only when present + non-empty;
    // older backends omit them entirely. Forward + back compatible —
    // older snippet versions just ignore the unread fields.
    var bk = null;
    var bkRaw = payload.sponsored.brand_kit;
    if (bkRaw && (bkRaw.name || bkRaw.logo_url || bkRaw.domain)) {
      bk = {
        name:       bkRaw.name        || null,
        logoUrl:    bkRaw.logo_url    || null,
        faviconUrl: bkRaw.favicon_url || null,
        color:      bkRaw.color       || null,
        domain:     bkRaw.domain      || null,
      };
    }
    var vc = null;
    var vcRaw = payload.sponsored.voucher;
    if (vcRaw && vcRaw.value_text) {
      vc = {
        valueText:     vcRaw.value_text     || null,
        code:          vcRaw.code           || null,
        redemptionUrl: vcRaw.redemption_url || null,
      };
    }
    return {
      adId:         payload.sponsored.campaign_id,
      auctionId:    payload.auction && payload.auction.auction_id,
      type:         payload.sponsored.type || "native",
      headline:     payload.sponsored.headline || "",
      subtext:      payload.sponsored.subtext || "",
      mediaUrl:     payload.sponsored.media_url || null,
      posterUrl:    payload.sponsored.poster_url || null,
      ctaLabel:     payload.sponsored.cta_label || "Learn more",
      ctaUrl:       payload.sponsored.cta_url || "#",
      disclosure:   payload.sponsored.disclosure_label || "Sponsored",
      tracking:     payload.sponsored.tracking || {},
      isSandbox:    !!(payload.auction && payload.auction.sandbox),
      brandKit:     bk,
      voucher:      vc,
    };
  }

  // ── Beacons ────────────────────────────────────────────────────────
  // Fire a server-side tracking beacon. The URL is minted by the auction
  // and already carries auction_id + the context fingerprint (ctx=), so
  // every impression / click / dismiss is context-joined. Image() is used
  // so cross-origin GET beacons don't trip CORS.
  function beacon(url) {
    if (!url) return;
    try {
      const img = new Image(1, 1);
      img.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;";
      img.src = url;
    } catch (_e) { /* ignore */ }
  }

  // ── Slot context derivation ────────────────────────────────────────
  function deriveContext(el) {
    const explicit = el.getAttribute("data-lumi-context");
    if (explicit && explicit.trim()) return explicit.trim();
    const h1 = document.querySelector("h1");
    const title = (h1 && h1.textContent && h1.textContent.trim()) ||
                  document.title ||
                  location.pathname;
    return String(title).slice(0, 280);
  }

  // ── Rendering ──────────────────────────────────────────────────────
  function makeDisclosure(ad) {
    const span = document.createElement("span");
    span.className = "lumi-disclosure";
    span.textContent = ad.disclosure;
    return span;
  }

  // Brand line — logo + "Sponsored by [name] · [domain]". Returns null
  // when the advertiser hasn't filled their global Creatives library.
  function makeBrandLine(ad) {
    const bk = ad.brandKit;
    if (!bk || (!bk.name && !bk.logoUrl && !bk.domain)) return null;
    const wrap = document.createElement("span");
    wrap.className = "lumi-brand";
    if (bk.logoUrl) {
      const img = document.createElement("img");
      img.className = "lumi-brand__logo";
      img.src = bk.logoUrl;
      img.alt = "";
      img.onerror = function () { img.remove(); };
      wrap.appendChild(img);
    }
    if (bk.name) {
      wrap.appendChild(document.createTextNode("Sponsored by "));
      const n = document.createElement("span");
      n.className = "lumi-brand__name";
      n.textContent = bk.name;
      wrap.appendChild(n);
    }
    if (bk.domain) {
      const dot = document.createElement("span");
      dot.className = "lumi-brand__dot";
      dot.textContent = bk.name ? " · " : "";
      wrap.appendChild(dot);
      const d = document.createElement("span");
      d.className = "lumi-brand__domain";
      d.textContent = bk.domain;
      wrap.appendChild(d);
    }
    return wrap;
  }

  // Voucher endcard — sits above the CTA on card + corner placements.
  // Null when no voucher is set on the library.
  function makeVoucher(ad) {
    const v = ad.voucher;
    if (!v || !v.valueText) return null;
    const wrap = document.createElement("div");
    wrap.className = "lumi-voucher";
    const icon = document.createElement("span");
    icon.className = "lumi-voucher__icon";
    icon.textContent = "🎟";
    wrap.appendChild(icon);
    const body = document.createElement("div");
    body.className = "lumi-voucher__body";
    const value = document.createElement("span");
    value.className = "lumi-voucher__value";
    value.textContent = v.valueText;
    body.appendChild(value);
    if (v.code) {
      const code = document.createElement("span");
      code.className = "lumi-voucher__code";
      code.textContent = "Code: " + v.code;
      body.appendChild(code);
    }
    wrap.appendChild(body);
    return wrap;
  }

  function closeButton(onClick) {
    const b = document.createElement("button");
    b.className = "lumi-x";
    b.setAttribute("aria-label", "Dismiss");
    b.textContent = "×";
    b.addEventListener("click", onClick);
    return b;
  }

  // ── Save-to-affiliate button + popover ───────────────────────────────
  // Third interaction option alongside close + click. Lets a viewer
  // bookmark the ad to their affiliate list at affiliate.boostboss.ai.
  // Self-contained state machine inside this function: closed →
  // confirm → (signup if needed) → saving → done/error. Session is
  // persisted to localStorage as bb_affiliate_session so subsequent
  // saves on the same site skip the signup form.
  //
  // The button is meant to live in the top-LEFT corner of the ad,
  // mirroring the close X in the top-right.
  function saveAffiliateButton(ad, slotEl) {
    const btn = document.createElement("button");
    btn.className = "lumi-save";
    btn.setAttribute("aria-label", "Save to affiliate");
    btn.title = "Save to affiliate";
    // Bookmark icon (Material Design "bookmark" path)
    btn.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
      + '<path d="M19 3H5C3.9 3 3 3.9 3 5V21L12 17L21 21V5C21 3.9 20.1 3 19 3M19 18L12 15L5 18V5H19V18Z"/>'
      + '</svg>';

    let pop = null;
    let state = "closed";  // closed | confirm | signup | signin | saving | done | error
    let errMsg = "";

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (state === "closed") openPop();
      else                    closePop();
    });

    function openPop() {
      closePop();
      pop = document.createElement("div");
      pop.className = "lumi-save-pop";
      pop.addEventListener("click", function (e) { e.stopPropagation(); });
      btn.parentNode.appendChild(pop);
      state = "confirm";
      renderPop();
      setTimeout(function () { document.addEventListener("click", outsideClick); }, 0);
    }
    function closePop() {
      if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
      pop = null;
      state = "closed";
      document.removeEventListener("click", outsideClick);
    }
    function outsideClick(e) {
      if (pop && !pop.contains(e.target) && !btn.contains(e.target)) closePop();
    }

    function getSession() {
      try { return JSON.parse(localStorage.getItem("bb_affiliate_session") || "null"); } catch (_) { return null; }
    }
    function setSession(s) {
      try { localStorage.setItem("bb_affiliate_session", JSON.stringify(s)); } catch (_) {}
    }

    function escAttr(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
      });
    }

    function renderPop() {
      if (!pop) return;
      if (state === "confirm") {
        pop.innerHTML =
          '<div class="lumi-save-pop__title">Save to affiliate?</div>'
        + '<div class="lumi-save-pop__sub">Bookmark this ad to your Boost Boss affiliate list. Share it later, earn when it converts.</div>'
        + '<div class="lumi-save-pop__row">'
        +   '<button type="button" class="lumi-save-pop__btn" data-act="cancel">No</button>'
        +   '<button type="button" class="lumi-save-pop__btn lumi-save-pop__btn--primary" data-act="save">Yes, save</button>'
        + '</div>';
        pop.querySelector('[data-act="cancel"]').addEventListener("click", closePop);
        pop.querySelector('[data-act="save"]').addEventListener("click", onSave);
      } else if (state === "signup") {
        pop.innerHTML =
          '<div class="lumi-save-pop__title">Create affiliate account</div>'
        + '<div class="lumi-save-pop__sub">One step. No email confirmation.</div>'
        + '<div class="lumi-save-pop__err' + (errMsg ? " is-show" : "") + '">' + escAttr(errMsg) + '</div>'
        + '<div class="lumi-save-pop__field"><input type="email" autocomplete="email" placeholder="you@example.com" data-f="email"></div>'
        + '<div class="lumi-save-pop__field"><input type="password" autocomplete="new-password" placeholder="Password (8+ chars)" data-f="pw1"></div>'
        + '<div class="lumi-save-pop__field"><input type="password" autocomplete="new-password" placeholder="Confirm password" data-f="pw2"></div>'
        + '<div class="lumi-save-pop__row">'
        +   '<button type="button" class="lumi-save-pop__btn" data-act="cancel">Cancel</button>'
        +   '<button type="button" class="lumi-save-pop__btn lumi-save-pop__btn--primary" data-act="signup">Sign up &amp; save</button>'
        + '</div>'
        + '<div class="lumi-save-pop__foot">Already have an account? '
        + '<a href="#" data-act="goto-signin">Sign in</a></div>';
        pop.querySelector('[data-act="cancel"]').addEventListener("click", closePop);
        pop.querySelector('[data-act="signup"]').addEventListener("click", onSignup);
        pop.querySelector('[data-act="goto-signin"]').addEventListener("click", function (e) {
          e.preventDefault(); errMsg = ""; state = "signin"; renderPop();
        });
        const emailInput = pop.querySelector('[data-f="email"]');
        if (emailInput) setTimeout(function () { emailInput.focus(); }, 0);
      } else if (state === "signin") {
        // Inline sign-in path. Existing affiliates authenticate here and the
        // save fires immediately on success — no jump to affiliate.boostboss.ai
        // and back. Bug fix for the "click Sign in, land on dashboard, nothing
        // happens" report.
        pop.innerHTML =
          '<div class="lumi-save-pop__title">Sign in to save</div>'
        + '<div class="lumi-save-pop__sub">Welcome back. We&rsquo;ll save this ad to your affiliate list.</div>'
        + '<div class="lumi-save-pop__err' + (errMsg ? " is-show" : "") + '">' + escAttr(errMsg) + '</div>'
        + '<div class="lumi-save-pop__field"><input type="email" autocomplete="email" placeholder="you@example.com" data-f="email"></div>'
        + '<div class="lumi-save-pop__field"><input type="password" autocomplete="current-password" placeholder="Password" data-f="pw"></div>'
        + '<div class="lumi-save-pop__row">'
        +   '<button type="button" class="lumi-save-pop__btn" data-act="cancel">Cancel</button>'
        +   '<button type="button" class="lumi-save-pop__btn lumi-save-pop__btn--primary" data-act="signin">Sign in &amp; save</button>'
        + '</div>'
        + '<div class="lumi-save-pop__foot">New here? '
        + '<a href="#" data-act="goto-signup">Sign up</a></div>';
        pop.querySelector('[data-act="cancel"]').addEventListener("click", closePop);
        pop.querySelector('[data-act="signin"]').addEventListener("click", onSignin);
        pop.querySelector('[data-act="goto-signup"]').addEventListener("click", function (e) {
          e.preventDefault(); errMsg = ""; state = "signup"; renderPop();
        });
        const pwInput  = pop.querySelector('[data-f="pw"]');
        const emInput  = pop.querySelector('[data-f="email"]');
        // Submit on Enter from either field
        [emInput, pwInput].forEach(function (el) {
          if (!el) return;
          el.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); onSignin(); }
          });
        });
        if (emInput) setTimeout(function () { emInput.focus(); }, 0);
      } else if (state === "saving") {
        pop.innerHTML = '<div class="lumi-save-pop__sub" style="text-align:center;padding:10px 0;margin:0;">Saving…</div>';
      } else if (state === "done") {
        pop.innerHTML =
          '<div class="lumi-save-pop__done">'
        +   '<div class="check">✓</div>'
        +   '<div class="lumi-save-pop__title" style="margin-bottom:4px;">Saved</div>'
        +   '<div class="lumi-save-pop__sub" style="margin-bottom:0;"><a href="https://affiliate.boostboss.ai" target="_blank" rel="noopener" style="color:var(--_p);font-weight:600;text-decoration:none;">View your saves →</a></div>'
        + '</div>';
        btn.classList.add("is-saved");
        setTimeout(closePop, 2400);
      } else if (state === "error") {
        pop.innerHTML =
          '<div class="lumi-save-pop__title">Couldn’t save</div>'
        + '<div class="lumi-save-pop__err is-show" style="margin-bottom:12px;">' + escAttr(errMsg || "Try again later.") + '</div>'
        + '<div class="lumi-save-pop__row">'
        +   '<button type="button" class="lumi-save-pop__btn" data-act="cancel">Close</button>'
        +   '<button type="button" class="lumi-save-pop__btn lumi-save-pop__btn--primary" data-act="retry">Retry</button>'
        + '</div>';
        pop.querySelector('[data-act="cancel"]').addEventListener("click", closePop);
        pop.querySelector('[data-act="retry"]').addEventListener("click", onSave);
      }
    }

    async function onSave() {
      const session = getSession();
      if (!session || !session.token) {
        // Default to sign-in for the no-session case. After the first save,
        // users are signed up; sign-in is the more common return path. New
        // users tap the "Sign up" link in the foot to switch forms.
        errMsg = "";
        state = "signin";
        renderPop();
        return;
      }
      state = "saving";
      renderPop();
      try {
        await postSave(session.token);
        state = "done";
        renderPop();
      } catch (err) {
        const msg = (err && err.message) || "";
        // 401 → token expired/invalid. Drop session, bounce to inline signin
        // (not signup — the user already exists, they just need to re-auth).
        if (/401|invalid token/i.test(msg)) {
          try { localStorage.removeItem("bb_affiliate_session"); } catch (_) {}
          errMsg = "Session expired — please sign in again.";
          state = "signin";
          renderPop();
          return;
        }
        // 403 not_affiliate → JWT is valid but the user isn't an affiliate.
        // This happens if their Supabase auth user exists from another role
        // (advertiser/publisher) but they've never signed up for the
        // affiliate dashboard. Drop the session and route to signup so
        // they explicitly opt in.
        if (/403|not_affiliate|Not an affiliate/i.test(msg)) {
          try { localStorage.removeItem("bb_affiliate_session"); } catch (_) {}
          errMsg = "Sign up for the affiliate dashboard to save ads.";
          state = "signup";
          renderPop();
          return;
        }
        errMsg = msg || "Save failed";
        state = "error";
        renderPop();
      }
    }

    async function onSignin() {
      const get = function (sel) { const el = pop.querySelector(sel); return el ? el.value : ""; };
      const email = (get('[data-f="email"]') || "").trim().toLowerCase();
      const pw    = get('[data-f="pw"]');
      if (!email)   { errMsg = "Enter your email.";    state = "signin"; renderPop(); return; }
      if (!pw)      { errMsg = "Enter your password."; state = "signin"; renderPop(); return; }

      state = "saving";
      renderPop();
      try {
        const r = await fetch(apiBase.replace(/\/$/, "") + "/api/auth?action=affiliate_login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email, password: pw }),
        });
        const j = await r.json();
        if (!r.ok) {
          // 403 not_affiliate → user has a Supabase auth row from another
          // role (advertiser/publisher) but no affiliates row. Route to
          // signup so they explicitly opt into the affiliate dashboard.
          if (r.status === 403 || (j && j.code === "not_affiliate")) {
            errMsg = "No affiliate account on this email — sign up below.";
            state = "signup";
            renderPop();
            return;
          }
          throw new Error((j && j.error) || "Sign in failed");
        }
        setSession({ token: j.token, user: j.user });
        await postSave(j.token);
        state = "done";
        renderPop();
      } catch (err) {
        errMsg = (err && err.message) || "Couldn’t sign in";
        state = "signin";
        renderPop();
      }
    }

    async function onSignup() {
      const get = function (sel) { const el = pop.querySelector(sel); return el ? el.value : ""; };
      const email = (get('[data-f="email"]') || "").trim().toLowerCase();
      const pw1   = get('[data-f="pw1"]');
      const pw2   = get('[data-f="pw2"]');
      if (!email)             { errMsg = "Enter your email.";              state = "signup"; renderPop(); return; }
      if ((pw1 || "").length < 8) { errMsg = "Password must be 8+ characters."; state = "signup"; renderPop(); return; }
      if (pw1 !== pw2)        { errMsg = "Passwords don’t match.";    state = "signup"; renderPop(); return; }

      state = "saving";
      renderPop();
      try {
        const r = await fetch(apiBase.replace(/\/$/, "") + "/api/auth?action=affiliate_signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email, password: pw1 }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Signup failed");
        setSession({ token: j.token, user: j.user });
        await postSave(j.token);
        state = "done";
        renderPop();
      } catch (err) {
        errMsg = (err && err.message) || "Couldn’t sign up";
        state = "signup";  // stay on signup form so they can retry
        renderPop();
      }
    }

    async function postSave(token) {
      const payload = {
        campaign_id:         ad.campaignId   || ad.campaign_id   || null,
        advertiser_id:       ad.advertiserId || ad.advertiser_id || null,
        headline:            ad.headline   || null,
        body:                ad.subtext    || null,
        image_url:           (ad.media && ad.media.url) || ad.imageUrl || null,
        target_url:          ad.ctaUrl     || null,
        source_placement_id: (slotEl && slotEl.getAttribute && slotEl.getAttribute("data-lumi-slot")) || null,
        source_surface:      "web",
      };
      const r = await fetch(apiBase.replace(/\/$/, "") + "/api/auth?action=affiliate_save_ad", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) {
        // Surface status in the thrown message so onSave() can branch on
        // 401 (expired token) vs 403 (not_affiliate) vs everything else.
        const code = (j && j.code) || "";
        throw new Error((j && j.error) || "Save failed", { cause: code });
      }
      // Tracking — let the publisher know an affiliate save happened.
      dispatch("affiliate_save", { adId: ad.adId, auctionId: ad.auctionId });
      return j;
    }

    return btn;
  }

  function buildCta(ad, slotEl, cls) {
    const a = document.createElement("a");
    a.className = "lumi-cta" + (cls ? " " + cls : "");
    a.href = ad.ctaUrl;
    a.target = "_blank";
    a.rel = "noopener sponsored";
    a.textContent = ad.ctaLabel;
    a.addEventListener("click", function () {
      // Server-side click feedback — context-joined via the ctx= in the URL.
      beacon(ad.tracking && ad.tracking.click);
      dispatch("click", { adId: ad.adId, auctionId: ad.auctionId, slot: slotEl });
    });
    return a;
  }

  function addMedia(parent, ad, cls) {
    if (!ad.mediaUrl) return;
    const img = document.createElement("img");
    img.className = cls;
    img.src = ad.mediaUrl;
    img.alt = "";
    img.onerror = function () { img.remove(); };
    parent.appendChild(img);
  }

  // card — inline sponsored card with a dismiss control.
  function renderCard(el, ad) {
    el.classList.add("lumi-cardbox");
    el.innerHTML = "";
    el.appendChild(closeButton(function () {
      beacon(ad.tracking && ad.tracking.dismiss);
      dispatch("close", { adId: ad.adId, auctionId: ad.auctionId });
      el.innerHTML = ""; el.style.display = "none";
    }));
    el.appendChild(saveAffiliateButton(ad, el));
    el.appendChild(makeDisclosure(ad));
    var brandC = makeBrandLine(ad);
    if (brandC) el.appendChild(brandC);
    addMedia(el, ad, "lumi-cardbox__media");
    const h = document.createElement("p");
    h.className = "lumi-cardbox__title";
    h.textContent = ad.headline;
    el.appendChild(h);
    if (ad.subtext) {
      const s = document.createElement("p");
      s.className = "lumi-cardbox__sub";
      s.textContent = ad.subtext;
      el.appendChild(s);
    }
    var voucherC = makeVoucher(ad);
    if (voucherC) el.appendChild(voucherC);
    el.appendChild(buildCta(ad, el, "lumi-cardbox__cta"));
  }

  // corner — sticky anchored unit. Mounts a fixed-position element to the
  // body; the slot div itself becomes a hidden cleanup anchor.
  function renderCorner(el, ad) {
    el.style.display = "none";
    const anchor = document.createElement("div");
    anchor.className = "lumi-corner-anchor";
    const card = document.createElement("div");
    card.className = "lumi-corner";
    card.appendChild(closeButton(function () {
      beacon(ad.tracking && ad.tracking.close);
      dispatch("close", { adId: ad.adId, auctionId: ad.auctionId });
      if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
    }));
    card.appendChild(saveAffiliateButton(ad, el));
    card.appendChild(makeDisclosure(ad));
    var brandCorner = makeBrandLine(ad);
    if (brandCorner) card.appendChild(brandCorner);
    addMedia(card, ad, "lumi-corner__media");
    const h = document.createElement("p");
    h.className = "lumi-corner__title";
    h.textContent = ad.headline;
    card.appendChild(h);
    if (ad.subtext) {
      const s = document.createElement("p");
      s.className = "lumi-corner__sub";
      s.textContent = ad.subtext;
      card.appendChild(s);
    }
    var voucherCorner = makeVoucher(ad);
    if (voucherCorner) card.appendChild(voucherCorner);
    card.appendChild(buildCta(ad, el, "lumi-corner__cta"));
    anchor.appendChild(card);
    document.body.appendChild(anchor);
    // Track the anchor so destroy()/unmountSlot can remove it.
    const slot = slots.get(el);
    if (slot) slot.backdrop = anchor;
  }

  // loading — "thinking"-state ad. Shown while the AI generates; the
  // publisher removes the slot element when the response is ready.
  function renderLoading(el, ad) {
    el.classList.add("lumi-loading");
    el.innerHTML = "";
    el.appendChild(makeDisclosure(ad));
    const h = document.createElement("div");
    h.className = "lumi-loading__title";
    h.textContent = ad.headline;
    el.appendChild(h);
    if (ad.subtext) {
      const s = document.createElement("div");
      s.className = "lumi-loading__sub";
      s.textContent = ad.subtext;
      el.appendChild(s);
    }
    const a = buildCta(ad, el, "lumi-loading__cta");
    a.textContent = ad.ctaLabel + " →";
    el.appendChild(a);
  }

  // citation — compact sponsored source, sits inline in an answer.
  function renderCitation(el, ad) {
    el.classList.add("lumi-citation");
    el.innerHTML = "";
    el.appendChild(makeDisclosure(ad));
    el.appendChild(document.createTextNode(" "));
    const t = document.createElement("span");
    t.className = "lumi-citation__title";
    t.textContent = ad.headline;
    el.appendChild(t);
    el.appendChild(document.createTextNode(" "));
    const a = buildCta(ad, el, "lumi-citation__cta");
    a.textContent = ad.ctaLabel + " ↗";
    el.appendChild(a);
  }

  // chip — suggested-action pill. The whole pill is the click target.
  function renderChip(el, ad) {
    el.innerHTML = "";
    const chip = document.createElement("a");
    chip.className = "lumi-chip";
    chip.href = ad.ctaUrl;
    chip.target = "_blank";
    chip.rel = "noopener sponsored";
    const dot = document.createElement("span");
    dot.className = "lumi-chip__dot";
    const label = document.createElement("span");
    label.textContent = ad.ctaLabel || ad.headline;
    const tag = document.createElement("span");
    tag.className = "lumi-chip__tag";
    tag.textContent = "Ad";
    chip.appendChild(dot);
    chip.appendChild(label);
    chip.appendChild(tag);
    chip.addEventListener("click", function () {
      beacon(ad.tracking && ad.tracking.click);
      dispatch("click", { adId: ad.adId, auctionId: ad.auctionId, slot: el });
    });
    el.appendChild(chip);
  }

  // image — a real image/banner ad. The whole unit is the click target.
  // Falls back to a card if the creative shipped no media (honest degrade).
  function renderImage(el, ad) {
    if (!ad.mediaUrl) return renderCard(el, ad);
    el.innerHTML = "";
    const a = document.createElement("a");
    a.className = "lumi-image";
    a.href = ad.ctaUrl; a.target = "_blank"; a.rel = "noopener sponsored";
    const img = document.createElement("img");
    img.className = "lumi-image__img";
    img.src = ad.mediaUrl; img.alt = ad.headline || "";
    // If the image itself fails, degrade to a card rather than show a broken unit.
    img.onerror = function () { renderCard(el, ad); };
    a.appendChild(img);
    const tag = document.createElement("span");
    tag.className = "lumi-image__tag"; tag.textContent = "Ad";
    a.appendChild(tag);
    if (ad.headline) {
      const cap = document.createElement("div");
      cap.className = "lumi-image__cap";
      const h = document.createElement("p");
      h.className = "lumi-image__h"; h.textContent = ad.headline;
      cap.appendChild(h);
      const cta = document.createElement("span");
      cta.className = "lumi-cta"; cta.textContent = ad.ctaLabel;
      cap.appendChild(cta);
      a.appendChild(cap);
    }
    a.addEventListener("click", function () {
      beacon(ad.tracking && ad.tracking.click);
      dispatch("click", { adId: ad.adId, auctionId: ad.auctionId, slot: el });
    });
    el.appendChild(a);
  }

  // interstitial / takeover / splash — full-page overlay mounted to <body>.
  // Close is gated for `delayMs` so the ad gets a beat of visibility.
  function renderInterstitial(el, ad) {
    el.style.display = "none";
    const backdrop = document.createElement("div");
    backdrop.className = "lumi-inter-backdrop";
    const card = document.createElement("div");
    card.className = "lumi-inter";

    const x = document.createElement("button");
    x.className = "lumi-inter__x"; x.type = "button"; x.textContent = "✕";
    x.setAttribute("aria-label", "Close ad"); x.disabled = true;
    function teardown(reason) {
      beacon(ad.tracking && ad.tracking.close);
      dispatch(reason || "close", { adId: ad.adId, auctionId: ad.auctionId });
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }
    x.addEventListener("click", function () { teardown("close"); });
    card.appendChild(x);

    if (ad.mediaUrl) {
      const img = document.createElement("img");
      img.className = "lumi-inter__img"; img.src = ad.mediaUrl; img.alt = "";
      img.onerror = function () { img.remove(); };
      card.appendChild(img);
    }
    const body = document.createElement("div");
    body.className = "lumi-inter__body";
    body.appendChild(makeDisclosure(ad));
    const h = document.createElement("p");
    h.className = "lumi-inter__h"; h.textContent = ad.headline;
    body.appendChild(h);
    if (ad.subtext) {
      const s = document.createElement("p");
      s.className = "lumi-inter__sub"; s.textContent = ad.subtext;
      body.appendChild(s);
    }
    var voucherI = makeVoucher(ad);
    if (voucherI) body.appendChild(voucherI);
    body.appendChild(buildCta(ad, el));
    card.appendChild(body);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    // Enable close after a short delay (skippable interstitial).
    setTimeout(function () { x.disabled = false; }, 4000);
    const slot = slots.get(el);
    if (slot) slot.backdrop = backdrop;
  }

  // video — pre-roll (autoplay muted, skippable) and rewarded (opt-in,
  // watch-to-complete → onReward). Poster/card fallback if media is missing
  // or fails. Mounts a full-screen player to <body>.
  function renderVideo(el, ad, rewarded) {
    if (!ad.mediaUrl) return renderCard(el, ad);   // no video creative → degrade
    el.style.display = "none";
    const backdrop = document.createElement("div");
    backdrop.className = "lumi-video-backdrop";

    function cleanup() { if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop); }
    function fireComplete() {
      beacon(ad.tracking && ad.tracking.complete);
      dispatch("complete", { adId: ad.adId, auctionId: ad.auctionId, rewarded: !!rewarded });
      if (rewarded) dispatch("reward", { adId: ad.adId, auctionId: ad.auctionId });
    }
    function endcard(withReward) {
      const ec = document.createElement("div");
      ec.className = "lumi-video__endcard";
      const h = document.createElement("h3");
      h.textContent = withReward ? "Reward unlocked" : (ad.headline || "Thanks for watching");
      ec.appendChild(h);
      ec.appendChild(buildCta(ad, el));
      const done = document.createElement("button");
      done.className = "lumi-video__skip"; done.style.position = "static";
      done.textContent = "Close";
      done.addEventListener("click", function () {
        dispatch("close", { adId: ad.adId, auctionId: ad.auctionId }); cleanup();
      });
      ec.appendChild(done);
      return ec;
    }

    function playPlayer() {
      const wrap = document.createElement("div");
      wrap.className = "lumi-video-wrap";
      const video = document.createElement("video");
      video.src = ad.mediaUrl;
      if (ad.posterUrl) video.poster = ad.posterUrl;
      video.playsInline = true; video.muted = !rewarded; video.autoplay = true;
      video.controls = false;
      video.onerror = function () {
        // Media failed: show poster as a static image ad, else degrade to card.
        cleanup();
        if (ad.posterUrl) { ad.mediaUrl = ad.posterUrl; el.style.display = ""; renderImage(el, ad); }
        else { el.style.display = ""; renderCard(el, ad); }
      };
      wrap.appendChild(video);

      // Skip — pre-roll only, after 5s. Rewarded has no skip (watch to earn).
      let skipBtn;
      if (!rewarded) {
        skipBtn = document.createElement("button");
        skipBtn.className = "lumi-video__skip"; skipBtn.disabled = true;
        skipBtn.textContent = "Skip in 5";
        let remain = 5;
        const iv = setInterval(function () {
          remain -= 1;
          skipBtn.textContent = remain > 0 ? ("Skip in " + remain) : "Skip ▸";
          if (remain <= 0) { skipBtn.disabled = false; clearInterval(iv); }
        }, 1000);
        skipBtn.addEventListener("click", function () {
          if (skipBtn.disabled) return;
          beacon(ad.tracking && ad.tracking.skip);
          dispatch("skip", { adId: ad.adId, auctionId: ad.auctionId }); cleanup();
        });
        wrap.appendChild(skipBtn);
      }

      video.addEventListener("ended", function () {
        fireComplete();
        wrap.appendChild(endcard(!!rewarded));
        if (skipBtn) skipBtn.remove();
      });
      backdrop.innerHTML = ""; backdrop.appendChild(wrap);
      const p = video.play(); if (p && p.catch) p.catch(function () {});
    }

    if (rewarded) {
      // Opt-in gate first — the rewarded contract (user chooses to watch).
      const optin = document.createElement("div");
      optin.className = "lumi-video__optin";
      const h = document.createElement("h3"); h.textContent = ad.headline || "Watch to earn your reward";
      const p = document.createElement("p"); p.textContent = ad.subtext || "Watch a short video to continue.";
      const go = document.createElement("button");
      go.className = "lumi-cta"; go.textContent = ad.ctaLabel && /watch/i.test(ad.ctaLabel) ? ad.ctaLabel : "Watch & earn";
      go.addEventListener("click", playPlayer);
      const no = document.createElement("button");
      no.className = "lumi-video__skip"; no.style.position = "static"; no.style.marginLeft = "8px";
      no.textContent = "No thanks";
      no.addEventListener("click", function () {
        dispatch("close", { adId: ad.adId, auctionId: ad.auctionId }); cleanup();
      });
      optin.appendChild(makeDisclosure(ad));
      optin.appendChild(h); optin.appendChild(p); optin.appendChild(go); optin.appendChild(no);
      backdrop.appendChild(optin);
    } else {
      backdrop.appendChild(document.createElement("div")); // placeholder; playPlayer fills it
    }
    document.body.appendChild(backdrop);
    if (!rewarded) playPlayer();
    const slot = slots.get(el);
    if (slot) slot.backdrop = backdrop;
  }

  function renderAdIntoSlot(el, ad) {
    const format = normalizeFormat(el.getAttribute("data-lumi-slot"));
    injectStyles();
    if (format === "corner")            renderCorner(el, ad);
    else if (format === "loading")      renderLoading(el, ad);
    else if (format === "citation")     renderCitation(el, ad);
    else if (format === "chip")         renderChip(el, ad);
    else if (format === "image")        renderImage(el, ad);
    else if (format === "interstitial") renderInterstitial(el, ad);
    else if (format === "video")        renderVideo(el, ad, false);
    else if (format === "rewarded")     renderVideo(el, ad, true);
    else                                renderCard(el, ad);   // card is the default

    beacon(ad.tracking && ad.tracking.impression);
    dispatch("impression", {
      adId: ad.adId, auctionId: ad.auctionId,
      slot: el, format, sandbox: ad.isSandbox,
    });
  }

  // ── Slot lifecycle ─────────────────────────────────────────────────
  async function mountSlot(el) {
    if (slots.has(el) && slots.get(el).mounted) return;   // already done

    const format    = normalizeFormat(el.getAttribute("data-lumi-slot"));
    const context   = deriveContext(el);
    const frequency = (el.getAttribute("data-lumi-frequency") || "session").toLowerCase();
    const fallback  = el.getAttribute("data-lumi-fallback");

    slots.set(el, { mounted: false, format, context, frequency, fallback, backdrop: null });

    log("mounting slot", { format, context });

    const ad = await fetchAd({ context, format });
    if (!ad) {
      // Show fallback if any
      if (fallback) {
        const fEl = document.querySelector(fallback);
        if (fEl) {
          const clone = fEl.cloneNode(true);
          clone.style.display = "";
          el.innerHTML = "";
          el.appendChild(clone);
        }
      }
      const slot = slots.get(el);
      if (slot) slot.mounted = true;
      return;
    }

    renderAdIntoSlot(el, ad);
    const slot = slots.get(el);
    if (slot) { slot.ad = ad; slot.mounted = true; }
  }

  function unmountSlot(el) {
    const slot = slots.get(el);
    if (!slot) return;
    if (slot.backdrop && slot.backdrop.parentNode) slot.backdrop.parentNode.removeChild(slot.backdrop);
    el.innerHTML = "";
    el.classList.remove("lumi-cardbox", "lumi-loading", "lumi-citation");
    el.style.display = "";
    slots.delete(el);
  }

  function discoverSlots() {
    const found = document.querySelectorAll("[data-lumi-slot]");
    for (let i = 0; i < found.length; i++) {
      const el = found[i];
      if (!slots.has(el)) mountSlot(el);
    }
  }

  // ── MutationObserver for SPAs ──────────────────────────────────────
  function startObserver() {
    if (observer || typeof MutationObserver === "undefined") return;
    observer = new MutationObserver(function (mutations) {
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type !== "childList") continue;
        // Newly-added slots
        m.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (node.matches && node.matches("[data-lumi-slot]")) mountSlot(node);
          if (node.querySelectorAll) {
            const inner = node.querySelectorAll("[data-lumi-slot]");
            for (let j = 0; j < inner.length; j++) mountSlot(inner[j]);
          }
        });
        // Removed slots — clean up state to avoid leaks
        m.removedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (slots.has(node)) unmountSlot(node);
          if (node.querySelectorAll) {
            const inner = node.querySelectorAll("[data-lumi-slot]");
            for (let j = 0; j < inner.length; j++) {
              if (slots.has(inner[j])) unmountSlot(inner[j]);
            }
          }
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  // ── Public API ─────────────────────────────────────────────────────
  const Lumi = {
    version:    VERSION,
    __loaded:   true,

    /** Re-fetch + re-render. Pass a CSS selector or element to scope; omit to refresh all. */
    refresh: function (selector) {
      if (!selector) {
        slots.forEach(function (_meta, el) {
          unmountSlot(el);
          mountSlot(el);
        });
        return;
      }
      let els;
      if (typeof selector === "string") els = document.querySelectorAll(selector);
      else if (selector instanceof Element) els = [selector];
      else els = [];
      for (let i = 0; i < els.length; i++) {
        if (slots.has(els[i])) unmountSlot(els[i]);
        mountSlot(els[i]);
      }
    },

    /** Tear down all rendered ads, observers, and event listeners. */
    destroy: function () {
      stopObserver();
      slots.forEach(function (_m, el) { unmountSlot(el); });
      slots.clear();
      const sty = document.getElementById("lumi-styles");
      if (sty) sty.remove();
      cssInjected = false;
      initialized = false;
    },

    /** Mount a slot manually (use when slot is added in a way the observer misses). */
    render: function (target, opts) {
      let el = null;
      if (typeof target === "string") el = document.querySelector(target);
      else if (target instanceof Element) el = target;
      if (!el) { emitError("BBX_BAD_TARGET", "render() target not found: " + target); return; }
      if (opts && opts.format) el.setAttribute("data-lumi-slot", opts.format);
      if (opts && opts.context) el.setAttribute("data-lumi-context", opts.context);
      if (slots.has(el)) unmountSlot(el);
      mountSlot(el);
    },

    /**
     * Programmatically create + mount an ad of a given format, without a
     * pre-existing slot element. Ideal for overlay formats (interstitial,
     * video, rewarded) triggered from code — e.g. Lumi.show('interstitial').
     * For inline formats (card/image/citation/chip) pass opts.container so
     * the unit has somewhere visible to render.
     *
     * @param {string} format   'interstitial' | 'video' | 'rewarded' | 'card' | 'image' | 'corner' | ...
     * @param {Object} [opts]   { context, container (selector|Element), frequency }
     * @returns {Element} the mounted slot element (removable with Lumi.destroy or el.remove()).
     */
    show: function (format, opts) {
      opts = opts || {};
      var fmt = String(format || opts.format || "card");
      var el = document.createElement("div");
      el.setAttribute("data-lumi-slot", fmt);
      if (opts.context) el.setAttribute("data-lumi-context", opts.context);
      if (opts.frequency) el.setAttribute("data-lumi-frequency", opts.frequency);
      var container = null;
      if (opts.container) {
        container = (typeof opts.container === "string")
          ? document.querySelector(opts.container) : opts.container;
      }
      // Overlay formats mount themselves to <body>; inline formats render in
      // place, so they need a visible container (falls back to <body>).
      (container || document.body).appendChild(el);
      mountSlot(el);
      return el;
    },

    /**
     * Subscribe to Lumi lifecycle events (impression, click, close, no_fill,
     * complete, skip, reward, conversion, error, affiliate_save). The handler
     * receives the event detail. Returns an unsubscribe function.
     *
     *   const off = Lumi.on('impression', d => console.log('shown', d.adId));
     *   // ...later: off();
     */
    on: function (event, handler) {
      if (typeof handler !== "function") return function () {};
      var type = "lumi:" + String(event || "");
      var wrapped = function (e) { try { handler(e.detail, e); } catch (_) {} };
      window.addEventListener(type, wrapped);
      return function () { window.removeEventListener(type, wrapped); };
    },

    /**
     * Fire a conversion event tied to an ad served in this session.
     *
     * Phase B (2026-05-11) — adds publisher-side conversion firing for
     * in-app conversions (signup/purchase happens on the same page that
     * hosted the ad). For conventional advertiser-side conversions on a
     * separate thank-you page, advertisers should still use pixel.js with
     * the bbx_auc query param (see public/pixel.js).
     *
     * @param {Object} opts
     * @param {string} opts.type         conversion type, e.g. "signup", "purchase"
     * @param {string} [opts.adId]       campaign_id of the ad that converted (required if no slot match)
     * @param {string} [opts.auctionId]  auction_id of the originating ad (recommended for attribution)
     * @param {string|Element} [opts.slot] alternative — provide the slot we rendered into
     * @param {number} [opts.value]      conversion value in USD (e.g. 29.99)
     * @param {string} [opts.currency]   ISO 4217 currency; default USD
     * @param {string} [opts.externalId] advertiser's user/order id for reconciliation
     */
    trackConversion: function (opts) {
      opts = opts || {};
      if (!opts.type || typeof opts.type !== "string") {
        emitError("BBX_BAD_REQUEST", "trackConversion: 'type' is required (e.g. 'signup')");
        return;
      }

      // Resolve adId + auctionId from the slot reference if needed.
      var adId      = opts.adId      || null;
      var auctionId = opts.auctionId || null;
      if (!adId || !auctionId) {
        var slotEl = null;
        if (opts.slot) {
          slotEl = (typeof opts.slot === "string")
            ? document.querySelector(opts.slot)
            : opts.slot;
        }
        if (slotEl && slots.has(slotEl)) {
          var s = slots.get(slotEl);
          if (s && s.ad) {
            adId      = adId      || s.ad.adId;
            auctionId = auctionId || s.ad.auctionId;
          }
        } else {
          // Best-effort: walk every mounted slot and take the first
          // one's ad context. Useful for "one ad per page" sites that
          // don't bother passing slot references.
          slots.forEach(function (m) {
            if ((!adId || !auctionId) && m && m.ad) {
              adId      = adId      || m.ad.adId;
              auctionId = auctionId || m.ad.auctionId;
            }
          });
        }
      }

      if (!adId) {
        emitError("BBX_BAD_REQUEST",
          "trackConversion: cannot determine adId — pass opts.adId, opts.slot, or call after an ad has rendered");
        return;
      }

      var body = {
        event:           "conversion",
        campaign_id:     adId,
        auction_id:      auctionId,
        conversion_type: opts.type,
        value:           (opts.value != null) ? Number(opts.value) : null,
        currency:        opts.currency || "USD",
        external_id:     opts.externalId || null,
        session_id:      SESSION_ID,
      };

      try {
        fetch(apiBase.replace(/\/$/, "") + "/api/track", {
          method: "POST",
          keepalive: true,
          headers: {
            "Content-Type": "application/json",
            "X-Lumi-Source": "js-snippet",
          },
          body: JSON.stringify(body),
        }).then(function (r) {
          if (!r.ok) {
            emitError("BBX_HTTP_" + r.status, "conversion beacon rejected: HTTP " + r.status);
          } else {
            dispatch("conversion", {
              adId: adId, auctionId: auctionId,
              type: opts.type, value: body.value, currency: body.currency,
            });
          }
        }).catch(function (e) {
          emitError("BBX_NETWORK", "conversion beacon failed: " + (e && e.message));
        });
      } catch (e) {
        emitError("BBX_NETWORK", "conversion beacon threw: " + (e && e.message));
      }
    },

    /** Last error object or null. */
    getLastError: function () { return lastError; },

    /** Toggle debug logging at runtime. */
    setDebug: function (on) { debug = !!on; },

    /** Internal: read current state — useful for tests. */
    _state: function () {
      return { publisherId, apiBase, sessionId: SESSION_ID, slotCount: slots.size };
    },
  };

  window.Lumi = Lumi;

  // ── Boot ───────────────────────────────────────────────────────────
  function init() {
    if (initialized) return;
    initialized = true;
    if (!publisherId) {
      emitError("BBX_NO_PUBLISHER_ID",
        "lumi.js loaded but no data-publisher-id found. Add it to your <script> tag.");
      return;
    }
    log("boot", { publisherId, apiBase, sessionId: SESSION_ID });
    discoverSlots();
    startObserver();
    dispatch("ready", { version: VERSION, sessionId: SESSION_ID });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})(window, document);
