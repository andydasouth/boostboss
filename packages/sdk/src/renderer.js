/**
 * Browser renderer — drops a sponsored unit into the DOM.
 * Accepts an `AdResponse` from `getSponsoredContent` and mounts it.
 *
 * Formats:
 *   - "corner"   — fixed-position popover in bottom-right (default)
 *   - "inline"   — replaces the mount element's contents
 *   - "video"    — autoplay muted video with skip button
 *   - "banner"   — horizontal banner, full-width of mount
 */

const STYLES = `
  .bb-ad-root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-sizing: border-box; }
  .bb-ad-root * { box-sizing: inherit; }
  .bb-corner { position: fixed; bottom: 20px; right: 20px; width: 360px; background:#0A0A14; color:#F5F5F7;
               border-radius: 14px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.35);
               border: 1px solid #FF2D78; z-index: 2147483000; animation: bbIn .25s ease-out; }
  @keyframes bbIn { from { transform: translateY(12px); opacity: 0; } to { transform: none; opacity: 1; } }
  .bb-media { width: 100%; display: block; aspect-ratio: 16/9; object-fit: cover; background:#1A1A2E; }
  .bb-pad { padding: 14px 16px 16px; }
  .bb-head { font-size: 15px; font-weight: 700; margin: 0 0 4px; }
  .bb-sub  { font-size: 13px; color:#B0B0C7; margin: 0 0 12px; }
  .bb-cta  { display: inline-block; background:#FF2D78; color:#fff; padding: 8px 14px;
             border-radius: 8px; font-size: 13px; font-weight: 700; text-decoration: none; }
  .bb-close { position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,.35); border: none; color:#fff;
              width: 24px; height: 24px; border-radius: 999px; cursor: pointer; font-size: 14px; line-height: 22px; }
  .bb-label { position: absolute; top: 10px; left: 10px; background: #FFE600; color:#0A0A14;
              padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 700; letter-spacing: 1px; }
  .bb-banner { display: flex; align-items: center; gap: 14px; background:#F5F5F7; border: 1px solid #E5E7EB;
               border-radius: 10px; padding: 10px; color:#0A0A14; }
  .bb-banner img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; flex: 0 0 auto; }
  .bb-banner .bb-head { color:#0A0A14; }
  .bb-banner .bb-sub  { color:#6B6B83; }
`;

function injectStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById("bb-sdk-styles")) return;
  const s = document.createElement("style");
  s.id = "bb-sdk-styles";
  s.textContent = STYLES;
  document.head.appendChild(s);
}

function pingBeacon(url) {
  if (!url) return;
  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    navigator.sendBeacon(url);
  } else if (typeof fetch !== "undefined") {
    fetch(url, { method: "GET", mode: "no-cors", keepalive: true }).catch(() => {});
  }
}

function renderAd(adResponse, opts = {}) {
  if (typeof document === "undefined") throw new Error("renderer requires a browser environment");
  injectStyles();
  const ad = adResponse?.sponsored;
  if (!ad) return null;
  const format = opts.format || "corner";
  const onClose = opts.onClose || (() => {});

  const el = document.createElement("div");
  el.className = "bb-ad-root";

  if (format === "corner" || format === "video") {
    const card = document.createElement("div");
    card.className = "bb-corner";
    card.innerHTML = `
      <div style="position: relative;">
        ${ad.type === "video"
          ? `<video class="bb-media" src="${ad.media_url}" poster="${ad.poster_url || ""}" autoplay muted playsinline></video>`
          : `<img class="bb-media" src="${ad.media_url}" alt="">`}
        <span class="bb-label">SPONSORED</span>
        <button class="bb-close" aria-label="Close">×</button>
      </div>
      <div class="bb-pad">
        <h4 class="bb-head"></h4>
        <p class="bb-sub"></p>
        <a class="bb-cta" target="_blank" rel="noopener"></a>
      </div>`;
    card.querySelector(".bb-head").textContent = ad.headline;
    card.querySelector(".bb-sub").textContent = ad.subtext;
    const cta = card.querySelector(".bb-cta");
    cta.textContent = ad.cta_label;
    cta.href = ad.cta_url;
    cta.addEventListener("click", () => pingBeacon(ad.tracking?.click));
    card.querySelector(".bb-close").addEventListener("click", () => {
      pingBeacon(ad.tracking?.close);
      el.remove();
      onClose();
    });
    el.appendChild(card);
  } else if (format === "banner" || format === "inline") {
    const banner = document.createElement("div");
    banner.className = "bb-banner";
    banner.innerHTML = `
      <img src="${ad.media_url}" alt="">
      <div style="flex: 1 1 auto; min-width: 0;">
        <h4 class="bb-head"></h4>
        <p class="bb-sub"></p>
      </div>
      <a class="bb-cta" target="_blank" rel="noopener"></a>`;
    banner.querySelector(".bb-head").textContent = ad.headline;
    banner.querySelector(".bb-sub").textContent = ad.subtext;
    const cta = banner.querySelector(".bb-cta");
    cta.textContent = ad.cta_label;
    cta.href = ad.cta_url;
    cta.addEventListener("click", () => pingBeacon(ad.tracking?.click));
    el.appendChild(banner);
  }

  const mount = typeof opts.mount === "string" ? document.querySelector(opts.mount) : (opts.mount || document.body);
  if (format === "inline" || format === "banner") {
    mount.replaceChildren(el);
  } else {
    mount.appendChild(el);
  }

  // Fire impression beacon
  pingBeacon(ad.tracking?.impression);
  return el;
}

module.exports = { renderAd, injectStyles };
