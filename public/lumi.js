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
 *   <div data-lumi-slot="banner"></div>
 *   <div data-lumi-slot="sidebar" data-lumi-context="checkout flow"></div>
 *
 * Sandbox: data-publisher-id="pub_test_demo" returns a fixed test creative.
 *
 * Events dispatched on window:
 *   lumi:ready        — SDK booted
 *   lumi:impression   — slot rendered an ad
 *   lumi:click        — user clicked CTA
 *   lumi:close        — user dismissed (interstitial only)
 *   lumi:no_fill      — slot stayed empty
 *   lumi:error        — request or parse error; see e.detail.code
 *
 * Programmatic API:
 *   Lumi.refresh(selector?)  — re-fetch + re-render. No arg refreshes all.
 *   Lumi.destroy()           — tear down all rendered ads + observers.
 *   Lumi.render(el, opts)    — manual mount for a slot not auto-discovered.
 *   Lumi.getLastError()      — last error object or null.
 *   Lumi.setDebug(bool)      — toggle debug logging at runtime.
 *   Lumi.version             — semver string.
 */

(function (window, document) {
  "use strict";

  if (window.Lumi && window.Lumi.__loaded) return;     // idempotent

  // ── Config ─────────────────────────────────────────────────────────
  const VERSION    = "0.1.0";
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
.lumi-card, .lumi-banner, .lumi-sidebar, .lumi-inline, .lumi-interstitial {
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
.lumi-cta {
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--_p); color: #fff; font-weight: 600; font-size: 13px;
  padding: 8px 16px; border-radius: 8px; text-decoration: none; line-height: 1.2;
  transition: filter 0.15s; white-space: nowrap;
}
.lumi-cta:hover { filter: brightness(1.08); }

.lumi-banner {
  display: flex; align-items: center; gap: 16px;
  padding: 14px 16px; background: var(--_bg);
  border: 1px solid var(--_b); border-radius: var(--_r);
}
.lumi-banner__media { width: 64px; height: 64px; flex-shrink: 0; border-radius: 8px; object-fit: cover; }
.lumi-banner__body  { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.lumi-banner__title { font-size: 15px; font-weight: 600; line-height: 1.3; margin: 0; }
.lumi-banner__sub   { font-size: 13px; color: var(--_m); line-height: 1.4; margin: 0; }
.lumi-banner__cta   { flex-shrink: 0; }

.lumi-sidebar {
  display: flex; flex-direction: column; gap: 10px;
  padding: 18px; background: var(--_bg);
  border: 1px solid var(--_b); border-radius: var(--_r);
}
.lumi-sidebar__media { width: 100%; border-radius: 8px; object-fit: cover; }
.lumi-sidebar__title { font-size: 16px; font-weight: 700; line-height: 1.25; margin: 0; }
.lumi-sidebar__sub   { font-size: 14px; color: var(--_m); line-height: 1.45; margin: 0; }
.lumi-sidebar__cta   { align-self: stretch; padding: 10px 16px; }

.lumi-inline {
  font-size: 14px; line-height: 1.5; padding: 10px 12px;
  border-left: 3px solid var(--_p);
  background: var(--_bg); border-radius: 6px;
}
.lumi-inline__title { font-weight: 600; }
.lumi-inline__sub   { color: var(--_m); }
.lumi-inline__cta   {
  color: var(--_p); font-weight: 600; text-decoration: none;
  margin-left: 4px;
}
.lumi-inline__cta:hover { text-decoration: underline; }

.lumi-interstitial-backdrop {
  position: fixed; inset: 0; background: rgba(15, 15, 26, 0.55);
  display: flex; align-items: center; justify-content: center;
  z-index: 2147483646; padding: 20px;
}
.lumi-interstitial {
  position: relative; max-width: 420px; width: 100%;
  background: var(--_bg); border-radius: var(--_r);
  padding: 28px; box-shadow: 0 20px 60px rgba(0,0,0,0.30);
  display: flex; flex-direction: column; gap: 12px;
}
.lumi-interstitial__close {
  position: absolute; top: 8px; right: 10px;
  background: transparent; border: none; cursor: pointer;
  width: 32px; height: 32px; border-radius: 50%;
  font-size: 22px; color: var(--_m); line-height: 1;
}
.lumi-interstitial__close:hover { background: rgba(0,0,0,0.05); color: var(--_t); }
.lumi-interstitial__media { width: 100%; border-radius: 8px; }
.lumi-interstitial__title { font-size: 19px; font-weight: 700; line-height: 1.25; margin: 0; }
.lumi-interstitial__sub   { font-size: 14.5px; color: var(--_m); line-height: 1.5; margin: 0; }
.lumi-interstitial__cta   { padding: 12px 18px; font-size: 14px; align-self: flex-start; }

@media (max-width: 480px) {
  .lumi-banner { flex-direction: column; align-items: flex-start; gap: 12px; }
  .lumi-banner__cta { align-self: stretch; }
}
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

    const body = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "get_sponsored_content",
        arguments: {
          context_summary: context,
          format_preference: opts.format || "native",
          session_id: SESSION_ID,
          // Snippet uses publisher_id as the public identifier; backend
          // also accepts it under developer_api_key for sandbox prefix
          // detection (api/_lib/sandbox.js). Same value either way.
          developer_api_key: publisherId,
          publisher_id:      publisherId,
          user_language:     navigator.language ? navigator.language.split("-")[0] : "en",
          host_app:          "web",
          surface:           opts.surface || "web",
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

    return {
      adId:         payload.sponsored.campaign_id,
      auctionId:    payload.auction && payload.auction.auction_id,
      type:         payload.sponsored.type || "native",
      headline:     payload.sponsored.headline || "",
      subtext:      payload.sponsored.subtext || "",
      mediaUrl:     payload.sponsored.media_url || null,
      ctaLabel:     payload.sponsored.cta_label || "Learn more",
      ctaUrl:       payload.sponsored.cta_url || "#",
      disclosure:   payload.sponsored.disclosure_label || "Sponsored",
      tracking:     payload.sponsored.tracking || {},
      isSandbox:    !!(payload.auction && payload.auction.sandbox),
    };
  }

  // ── Beacons ────────────────────────────────────────────────────────
  function fireImpressionBeacon(ad) {
    if (!ad || !ad.tracking || !ad.tracking.impression) return;
    // Use Image() so we don't run into CORS issues; impression beacons
    // accept GET on any origin.
    try {
      const img = new Image(1, 1);
      img.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;";
      img.src = ad.tracking.impression;
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
  function buildCta(ad, slotEl, format) {
    const a = document.createElement("a");
    a.className = "lumi-cta lumi-" + format + "__cta";
    a.href = ad.ctaUrl;
    a.target = "_blank";
    a.rel = "noopener sponsored";
    a.textContent = ad.ctaLabel;
    a.addEventListener("click", function () {
      dispatch("click", { adId: ad.adId, auctionId: ad.auctionId, slot: slotEl });
    }, { once: false });
    return a;
  }

  function makeDisclosure(ad) {
    const span = document.createElement("span");
    span.className = "lumi-disclosure";
    span.textContent = ad.disclosure;
    return span;
  }

  function renderBanner(el, ad) {
    el.classList.add("lumi-card", "lumi-banner");
    el.innerHTML = "";
    if (ad.mediaUrl) {
      const img = document.createElement("img");
      img.className = "lumi-banner__media";
      img.src = ad.mediaUrl;
      img.alt = "";
      img.onerror = function () { img.remove(); };
      el.appendChild(img);
    }
    const body = document.createElement("div");
    body.className = "lumi-banner__body";
    body.appendChild(makeDisclosure(ad));
    const h = document.createElement("p");
    h.className = "lumi-banner__title";
    h.textContent = ad.headline;
    body.appendChild(h);
    if (ad.subtext) {
      const s = document.createElement("p");
      s.className = "lumi-banner__sub";
      s.textContent = ad.subtext;
      body.appendChild(s);
    }
    el.appendChild(body);
    el.appendChild(buildCta(ad, el, "banner"));
  }

  function renderSidebar(el, ad) {
    el.classList.add("lumi-card", "lumi-sidebar");
    el.innerHTML = "";
    el.appendChild(makeDisclosure(ad));
    if (ad.mediaUrl) {
      const img = document.createElement("img");
      img.className = "lumi-sidebar__media";
      img.src = ad.mediaUrl;
      img.alt = "";
      img.onerror = function () { img.remove(); };
      el.appendChild(img);
    }
    const h = document.createElement("p");
    h.className = "lumi-sidebar__title";
    h.textContent = ad.headline;
    el.appendChild(h);
    if (ad.subtext) {
      const s = document.createElement("p");
      s.className = "lumi-sidebar__sub";
      s.textContent = ad.subtext;
      el.appendChild(s);
    }
    el.appendChild(buildCta(ad, el, "sidebar"));
  }

  function renderInline(el, ad) {
    el.classList.add("lumi-card", "lumi-inline");
    el.innerHTML = "";
    el.appendChild(makeDisclosure(ad));
    el.appendChild(document.createTextNode(" "));
    const t = document.createElement("span");
    t.className = "lumi-inline__title";
    t.textContent = ad.headline;
    el.appendChild(t);
    if (ad.subtext) {
      el.appendChild(document.createTextNode(" — "));
      const s = document.createElement("span");
      s.className = "lumi-inline__sub";
      s.textContent = ad.subtext;
      el.appendChild(s);
    }
    el.appendChild(document.createTextNode(" "));
    const a = buildCta(ad, el, "inline");
    a.className = "lumi-inline__cta";        // override; inline CTA is link-style
    a.textContent = ad.ctaLabel + " →";
    el.appendChild(a);
  }

  function renderInterstitial(el, ad) {
    // Interstitial mounts to body, not the slot element. The slot itself
    // becomes a hidden anchor we use for cleanup tracking.
    el.classList.add("lumi-card");
    el.style.display = "none";

    const backdrop = document.createElement("div");
    backdrop.className = "lumi-interstitial-backdrop";

    const card = document.createElement("div");
    card.className = "lumi-card lumi-interstitial";

    const closeBtn = document.createElement("button");
    closeBtn.className = "lumi-interstitial__close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", function () {
      dispatch("close", { adId: ad.adId, auctionId: ad.auctionId });
      backdrop.remove();
    });

    card.appendChild(closeBtn);
    card.appendChild(makeDisclosure(ad));
    if (ad.mediaUrl) {
      const img = document.createElement("img");
      img.className = "lumi-interstitial__media";
      img.src = ad.mediaUrl;
      img.alt = "";
      img.onerror = function () { img.remove(); };
      card.appendChild(img);
    }
    const h = document.createElement("p");
    h.className = "lumi-interstitial__title";
    h.textContent = ad.headline;
    card.appendChild(h);
    if (ad.subtext) {
      const s = document.createElement("p");
      s.className = "lumi-interstitial__sub";
      s.textContent = ad.subtext;
      card.appendChild(s);
    }
    card.appendChild(buildCta(ad, el, "interstitial"));
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    // Track the backdrop so destroy() can remove it.
    const slot = slots.get(el);
    if (slot) slot.backdrop = backdrop;
  }

  function renderAdIntoSlot(el, ad) {
    const format = el.getAttribute("data-lumi-slot");
    injectStyles();
    if (format === "sidebar")           renderSidebar(el, ad);
    else if (format === "inline")       renderInline(el, ad);
    else if (format === "interstitial") renderInterstitial(el, ad);
    else                                renderBanner(el, ad);   // banner is the default

    fireImpressionBeacon(ad);
    dispatch("impression", {
      adId: ad.adId, auctionId: ad.auctionId,
      slot: el, format, sandbox: ad.isSandbox,
    });
  }

  // ── Slot lifecycle ─────────────────────────────────────────────────
  async function mountSlot(el) {
    if (slots.has(el) && slots.get(el).mounted) return;   // already done

    const format    = el.getAttribute("data-lumi-slot") || "banner";
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
    el.classList.remove("lumi-card", "lumi-banner", "lumi-sidebar", "lumi-inline", "lumi-interstitial");
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
