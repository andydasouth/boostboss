/**
 * DOM rendering for the four ad formats.
 *
 * Same visual treatment as public/lumi.js (the script-tag SDK) — banner,
 * sidebar, inline, interstitial. CSS variable theming via :root or any
 * ancestor of the slot. No eval, no innerHTML for content (only for
 * clearing), no inline event handlers — all DOM via createElement so
 * we pass Manifest v3 / strict CSP review.
 */
import type { AdPayload } from "./types.js";

const CSS = `
.lumi-card, .lumi-banner, .lumi-sidebar, .lumi-inline, .lumi-interstitial {
  --_p:   var(--lumi-primary, #FF2D78);
  --_t:   var(--lumi-text, #0F0F1A);
  --_m:   var(--lumi-muted, #6B7280);
  --_bg:  var(--lumi-bg, #FFFFFF);
  --_b:   var(--lumi-border, #E5E7EB);
  --_r:   var(--lumi-radius, 12px);
  --_f:   var(--lumi-font, -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif);
  font-family: var(--_f); color: var(--_t); box-sizing: border-box;
}
.lumi-disclosure { display: inline-block; font-size: 11px; font-weight: 600; color: var(--_m); letter-spacing: 0.04em; text-transform: uppercase; }
.lumi-cta { display: inline-flex; align-items: center; justify-content: center; background: var(--_p); color: #fff; font-weight: 600; font-size: 13px; padding: 8px 16px; border-radius: 8px; text-decoration: none; line-height: 1.2; transition: filter 0.15s; white-space: nowrap; }
.lumi-cta:hover { filter: brightness(1.08); }
.lumi-banner { display: flex; align-items: center; gap: 16px; padding: 14px 16px; background: var(--_bg); border: 1px solid var(--_b); border-radius: var(--_r); }
.lumi-banner__media { width: 64px; height: 64px; flex-shrink: 0; border-radius: 8px; object-fit: cover; }
.lumi-banner__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.lumi-banner__title { font-size: 15px; font-weight: 600; line-height: 1.3; margin: 0; }
.lumi-banner__sub { font-size: 13px; color: var(--_m); line-height: 1.4; margin: 0; }
.lumi-sidebar { display: flex; flex-direction: column; gap: 10px; padding: 18px; background: var(--_bg); border: 1px solid var(--_b); border-radius: var(--_r); }
.lumi-sidebar__media { width: 100%; border-radius: 8px; object-fit: cover; }
.lumi-sidebar__title { font-size: 16px; font-weight: 700; line-height: 1.25; margin: 0; }
.lumi-sidebar__sub { font-size: 14px; color: var(--_m); line-height: 1.45; margin: 0; }
.lumi-sidebar__cta { align-self: stretch; padding: 10px 16px; }
.lumi-inline { font-size: 14px; line-height: 1.5; padding: 10px 12px; border-left: 3px solid var(--_p); background: var(--_bg); border-radius: 6px; }
.lumi-inline__title { font-weight: 600; }
.lumi-inline__sub { color: var(--_m); }
.lumi-inline__cta { color: var(--_p); font-weight: 600; text-decoration: none; margin-left: 4px; }
.lumi-inline__cta:hover { text-decoration: underline; }
.lumi-interstitial-backdrop { position: fixed; inset: 0; background: rgba(15, 15, 26, 0.55); display: flex; align-items: center; justify-content: center; z-index: 2147483646; padding: 20px; }
.lumi-interstitial { position: relative; max-width: 420px; width: 100%; background: var(--_bg); border-radius: var(--_r); padding: 28px; box-shadow: 0 20px 60px rgba(0,0,0,0.30); display: flex; flex-direction: column; gap: 12px; }
.lumi-interstitial__close { position: absolute; top: 8px; right: 10px; background: transparent; border: none; cursor: pointer; width: 32px; height: 32px; border-radius: 50%; font-size: 22px; color: var(--_m); line-height: 1; }
.lumi-interstitial__close:hover { background: rgba(0,0,0,0.05); color: var(--_t); }
.lumi-interstitial__media { width: 100%; border-radius: 8px; }
.lumi-interstitial__title { font-size: 19px; font-weight: 700; line-height: 1.25; margin: 0; }
.lumi-interstitial__sub { font-size: 14.5px; color: var(--_m); line-height: 1.5; margin: 0; }
.lumi-interstitial__cta { padding: 12px 18px; font-size: 14px; align-self: flex-start; }
@media (max-width: 480px) { .lumi-banner { flex-direction: column; align-items: flex-start; gap: 12px; } .lumi-banner__cta { align-self: stretch; } }
`;

let cssInjected = false;
export function injectStyles(target: Document = document): void {
  if (cssInjected) return;
  if (target.getElementById("lumi-styles")) { cssInjected = true; return; }
  const style = target.createElement("style");
  style.id = "lumi-styles";
  style.textContent = CSS;
  target.head.appendChild(style);
  cssInjected = true;
}

/**
 * Reset the cssInjected flag. Useful when destroy() is called and we
 * want a fresh render() to re-inject styles.
 * @internal
 */
export function resetStyles(): void { cssInjected = false; }

function makeDisclosure(label: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "lumi-disclosure";
  span.textContent = label;
  return span;
}

function buildCta(ad: AdPayload, format: string, onClick: () => void): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "lumi-cta lumi-" + format + "__cta";
  a.href = ad.ctaUrl;
  a.target = "_blank";
  a.rel = "noopener sponsored";
  a.textContent = ad.ctaLabel;
  a.addEventListener("click", onClick);
  return a;
}

export interface RenderResult {
  /** Backdrop element (interstitial only); null otherwise. Tracked for cleanup. */
  backdrop: HTMLElement | null;
}

export function renderAd(
  el: HTMLElement,
  ad: AdPayload,
  format: string,
  onClick: () => void,
): RenderResult {
  injectStyles();
  const f = format === "sidebar" || format === "inline" || format === "interstitial" ? format : "banner";
  if (f === "sidebar")           return renderSidebar(el, ad, onClick);
  if (f === "inline")            return renderInline(el, ad, onClick);
  if (f === "interstitial")      return renderInterstitial(el, ad, onClick);
  return renderBanner(el, ad, onClick);
}

function renderBanner(el: HTMLElement, ad: AdPayload, onClick: () => void): RenderResult {
  el.classList.add("lumi-card", "lumi-banner");
  el.innerHTML = "";
  if (ad.mediaUrl) {
    const img = document.createElement("img");
    img.className = "lumi-banner__media";
    img.src = ad.mediaUrl; img.alt = "";
    img.onerror = () => img.remove();
    el.appendChild(img);
  }
  const body = document.createElement("div");
  body.className = "lumi-banner__body";
  body.appendChild(makeDisclosure(ad.disclosureLabel));
  const h = document.createElement("p"); h.className = "lumi-banner__title"; h.textContent = ad.headline;
  body.appendChild(h);
  if (ad.body) {
    const s = document.createElement("p"); s.className = "lumi-banner__sub"; s.textContent = ad.body;
    body.appendChild(s);
  }
  el.appendChild(body);
  el.appendChild(buildCta(ad, "banner", onClick));
  return { backdrop: null };
}

function renderSidebar(el: HTMLElement, ad: AdPayload, onClick: () => void): RenderResult {
  el.classList.add("lumi-card", "lumi-sidebar");
  el.innerHTML = "";
  el.appendChild(makeDisclosure(ad.disclosureLabel));
  if (ad.mediaUrl) {
    const img = document.createElement("img");
    img.className = "lumi-sidebar__media";
    img.src = ad.mediaUrl; img.alt = "";
    img.onerror = () => img.remove();
    el.appendChild(img);
  }
  const h = document.createElement("p"); h.className = "lumi-sidebar__title"; h.textContent = ad.headline;
  el.appendChild(h);
  if (ad.body) {
    const s = document.createElement("p"); s.className = "lumi-sidebar__sub"; s.textContent = ad.body;
    el.appendChild(s);
  }
  el.appendChild(buildCta(ad, "sidebar", onClick));
  return { backdrop: null };
}

function renderInline(el: HTMLElement, ad: AdPayload, onClick: () => void): RenderResult {
  el.classList.add("lumi-card", "lumi-inline");
  el.innerHTML = "";
  el.appendChild(makeDisclosure(ad.disclosureLabel));
  el.appendChild(document.createTextNode(" "));
  const t = document.createElement("span"); t.className = "lumi-inline__title"; t.textContent = ad.headline;
  el.appendChild(t);
  if (ad.body) {
    el.appendChild(document.createTextNode(" — "));
    const s = document.createElement("span"); s.className = "lumi-inline__sub"; s.textContent = ad.body;
    el.appendChild(s);
  }
  el.appendChild(document.createTextNode(" "));
  const a = buildCta(ad, "inline", onClick);
  a.className = "lumi-inline__cta";
  a.textContent = ad.ctaLabel + " →";
  el.appendChild(a);
  return { backdrop: null };
}

function renderInterstitial(el: HTMLElement, ad: AdPayload, onClick: () => void): RenderResult {
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
  closeBtn.addEventListener("click", () => backdrop.remove());

  card.appendChild(closeBtn);
  card.appendChild(makeDisclosure(ad.disclosureLabel));
  if (ad.mediaUrl) {
    const img = document.createElement("img");
    img.className = "lumi-interstitial__media";
    img.src = ad.mediaUrl; img.alt = "";
    img.onerror = () => img.remove();
    card.appendChild(img);
  }
  const h = document.createElement("p"); h.className = "lumi-interstitial__title"; h.textContent = ad.headline;
  card.appendChild(h);
  if (ad.body) {
    const s = document.createElement("p"); s.className = "lumi-interstitial__sub"; s.textContent = ad.body;
    card.appendChild(s);
  }
  card.appendChild(buildCta(ad, "interstitial", onClick));
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  return { backdrop };
}

/**
 * Fire the impression beacon (fire-and-forget). Uses Image() so we never
 * hit CORS preflights — beacon endpoints accept GET on any origin.
 */
export function fireImpressionBeacon(url: string): void {
  try {
    const img = new Image(1, 1);
    img.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;";
    img.src = url;
  } catch (_e) { /* ignore */ }
}

/** Tear down a slot's DOM and any associated backdrop. */
export function unmountSlot(el: HTMLElement, backdrop: HTMLElement | null): void {
  if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
  el.innerHTML = "";
  el.classList.remove(
    "lumi-card", "lumi-banner", "lumi-sidebar", "lumi-inline", "lumi-interstitial",
  );
  el.style.display = "";
}
