/**
 * Boost Boss SDK v1.0.0
 * https://boostboss.ai
 *
 * Drop this into any web-based AI app to serve contextual ads.
 *
 * Usage:
 *   <script src="https://boostboss.ai/sdk.js" data-api-key="bb_dev_xxx"></script>
 *
 * Or initialize manually:
 *   BoostBoss.init({ apiKey: "bb_dev_xxx" });
 *   BoostBoss.requestAd({ context: "user is building a landing page" });
 */
(function (window, document) {
  "use strict";

  const VERSION = "1.0.0";
  let API_BASE = "https://boostboss.ai/api";
  const SESSION_ID = "bb_" + Math.random().toString(36).substr(2, 12) + "_" + Date.now();

  let config = {
    apiKey: null,
    formats: { corner: true, fullscreen: true, video: true, native: true },
    maxAdsPerSession: 10,
    minIntervalMs: 180000, // 3 min between ads
    position: "bottom-right", // bottom-right, bottom-left, top-right, top-left
    theme: "dark", // dark or light
    payToRemovePrice: "$4.99/mo",
    onImpression: null,
    onClick: null,
    onClose: null,
  };

  let state = {
    initialized: false,
    adsShown: 0,
    lastAdTime: 0,
    currentAd: null,
    skipTimer: null,
    progressTimer: null,
  };

  // ── Inject CSS ──
  function injectStyles() {
    if (document.getElementById("bb-sdk-styles")) return;
    const style = document.createElement("style");
    style.id = "bb-sdk-styles";
    style.textContent = `
      #bb-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:99998;animation:bb-fi .25s ease}
      #bb-popup{display:none;position:fixed;z-index:99999;animation:bb-si .35s cubic-bezier(.34,1.56,.64,1);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      #bb-popup.corner.bottom-right{bottom:24px;right:24px;width:320px}
      #bb-popup.corner.bottom-left{bottom:24px;left:24px;width:320px}
      #bb-popup.corner.top-right{top:24px;right:24px;width:320px}
      #bb-popup.corner.top-left{top:24px;left:24px;width:320px}
      #bb-popup.fullscreen{top:50%;left:50%;transform:translate(-50%,-50%);width:min(540px,94vw)}
      .bb-c{background:#111;border:1px solid #222;border-radius:16px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.75)}
      .bb-ch{padding:8px 12px;display:flex;align-items:center;justify-content:space-between;background:#0a0a0a;border-bottom:1px solid #1a1a1a}
      .bb-sl{display:flex;align-items:center;gap:6px;font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.08em;font-weight:600}
      .bb-sl .bb-i{width:14px;height:14px;border-radius:3px;background:#FF2D78;display:flex;align-items:center;justify-content:center;font-size:8px;color:#fff;font-weight:900}
      .bb-sr{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;border:2px solid #333;font-size:11px;color:#555;font-weight:700;transition:all .3s;cursor:default;user-select:none}
      .bb-sr.ready{border-color:#FF2D78;color:#FF2D78;cursor:pointer;background:rgba(255,45,120,.1)}
      .bb-sr.ready:hover{background:rgba(249,115,22,.25)}
      .bb-mw{position:relative;width:100%;aspect-ratio:16/9;background:#000;overflow:hidden}
      .bb-mw img,.bb-mw video{width:100%;height:100%;object-fit:cover;display:block}
      .bb-vo{display:none;position:absolute;inset:0;align-items:center;justify-content:center;background:rgba(0,0,0,.35);cursor:pointer}
      .bb-pb{width:56px;height:56px;border-radius:50%;background:rgba(255,255,255,.92);display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 4px 24px rgba(0,0,0,.5)}
      .bb-mb{position:absolute;bottom:10px;right:10px;background:rgba(0,0,0,.65);border:none;border-radius:6px;color:#fff;font-size:12px;padding:5px 10px;cursor:pointer;z-index:2}
      .bb-pr{position:absolute;bottom:0;left:0;height:3px;background:#FF2D78;width:0%;transition:width .15s linear;z-index:3}
      .bb-bd{padding:14px 16px 16px}
      .bb-hl{font-size:15px;font-weight:700;color:#fff;line-height:1.3;margin-bottom:4px}
      .bb-st{font-size:12px;color:#666;margin-bottom:12px}
      .bb-ct{display:block;background:#FF2D78;color:#fff;text-decoration:none;text-align:center;padding:10px;border-radius:8px;font-size:13px;font-weight:700;transition:opacity .2s}
      .bb-ct:hover{opacity:.9}
      .bb-pc{display:block;text-align:center;margin-top:8px;font-size:11px;color:#555;cursor:pointer}
      .bb-pc:hover{color:#FF2D78}
      .bb-na{background:#141414;border:1px solid #222;border-left:3px solid #FF2D78;border-radius:10px;padding:14px 16px;margin:8px 0}
      .bb-na .bb-nal{font-size:10px;color:#FF2D78;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;display:flex;align-items:center;gap:5px}
      .bb-na .bb-nat{font-size:14px;font-weight:700;color:#eee;margin-bottom:4px}
      .bb-na .bb-nad{font-size:12px;color:#888;margin-bottom:10px;line-height:1.5}
      .bb-na .bb-nac{display:inline-block;background:#FF2D78;color:#fff;text-decoration:none;padding:7px 16px;border-radius:6px;font-size:12px;font-weight:700}
      @keyframes bb-si{from{opacity:0;transform:translateY(20px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}
      @keyframes bb-fi{from{opacity:0}to{opacity:1}}
    `;
    document.head.appendChild(style);
  }

  // ── Inject DOM ──
  function injectDOM() {
    if (document.getElementById("bb-popup")) return;

    const backdrop = document.createElement("div");
    backdrop.id = "bb-backdrop";
    backdrop.onclick = () => BoostBoss.close();
    document.body.appendChild(backdrop);

    const popup = document.createElement("div");
    popup.id = "bb-popup";
    popup.innerHTML = `
      <div class="bb-c">
        <div class="bb-ch">
          <span class="bb-sl"><span class="bb-i">B</span>Sponsored · Boost Boss</span>
          <div class="bb-sr" id="bb-skip">5</div>
        </div>
        <div class="bb-mw">
          <img id="bb-img" src="" alt="Ad" style="display:none"/>
          <video id="bb-video" playsinline muted style="display:none"></video>
          <div class="bb-vo" id="bb-vo" onclick="BoostBoss.togglePlay()"><div class="bb-pb" id="bb-pi">▶</div></div>
          <button class="bb-mb" id="bb-mb" style="display:none" onclick="BoostBoss.toggleMute()">🔇 Unmute</button>
          <div class="bb-pr" id="bb-pr"></div>
        </div>
        <div class="bb-bd">
          <div class="bb-hl" id="bb-hl"></div>
          <div class="bb-st" id="bb-st"></div>
          <a class="bb-ct" id="bb-ct" href="#" target="_blank" rel="noopener"></a>
          <div class="bb-pc" id="bb-pc"></div>
        </div>
      </div>`;
    document.body.appendChild(popup);
  }

  // ── Track event via pixel ──
  function track(url) {
    if (!url) return;
    const img = new Image();
    img.src = url;
  }

  // ── Show ad ──
  function showAd(ad, format) {
    injectDOM();
    const popup = document.getElementById("bb-popup");
    const backdrop = document.getElementById("bb-backdrop");
    const skip = document.getElementById("bb-skip");
    const img = document.getElementById("bb-img");
    const video = document.getElementById("bb-video");
    const overlay = document.getElementById("bb-vo");
    const muteBtn = document.getElementById("bb-mb");
    const progress = document.getElementById("bb-pr");

    // Clean
    video.pause();
    video.removeAttribute("src");
    clearTimers();
    progress.style.width = "0%";

    state.currentAd = ad;

    // Populate
    document.getElementById("bb-hl").textContent = ad.headline;
    document.getElementById("bb-st").textContent = ad.subtext;
    const cta = document.getElementById("bb-ct");
    cta.textContent = ad.cta_label;
    cta.href = ad.cta_url;
    cta.onclick = (e) => {
      track(ad.tracking?.click);
      if (config.onClick) config.onClick(ad);
    };

    // Pay to close
    const pc = document.getElementById("bb-pc");
    if (config.payToRemovePrice) {
      pc.textContent = `Remove ads · ${config.payToRemovePrice}`;
      pc.style.display = "block";
    } else {
      pc.style.display = "none";
    }

    // Format
    const pos = config.position || "bottom-right";
    if (format === "fullscreen") {
      popup.className = "fullscreen";
      backdrop.style.display = "block";
    } else {
      popup.className = `corner ${pos}`;
    }

    if (ad.type === "image" || ad.type === "native") {
      img.src = ad.media_url;
      img.style.display = "block";
      video.style.display = "none";
      overlay.style.display = "none";
      muteBtn.style.display = "none";
      startSkip(skip, ad.skippable_after_sec || 3);
    } else if (ad.type === "video") {
      img.style.display = "none";
      video.style.display = "block";
      video.poster = ad.poster_url || "";
      video.muted = true;
      video.src = ad.media_url;
      muteBtn.style.display = "block";
      muteBtn.textContent = "🔇 Unmute";
      overlay.style.display = "flex";
      document.getElementById("bb-pi").textContent = "⏳";
      video.load();
      video.oncanplay = () => {
        document.getElementById("bb-pi").textContent = "▶";
        video.play().then(() => { overlay.style.display = "none"; startProgress(video, progress); }).catch(() => { overlay.style.display = "flex"; });
        video.oncanplay = null;
      };
      video.onended = () => {
        progress.style.width = "100%";
        clearTimers();
        skip.textContent = "✕";
        skip.className = "bb-sr ready";
        skip.onclick = () => BoostBoss.close();
        track(ad.tracking?.video_complete);
      };
      startSkip(skip, ad.skippable_after_sec || 5);
    }

    popup.style.display = "block";
    state.adsShown++;
    state.lastAdTime = Date.now();

    // Fire impression
    track(ad.tracking?.impression);
    if (config.onImpression) config.onImpression(ad);
  }

  function startSkip(el, sec) {
    el.className = "bb-sr";
    el.textContent = sec;
    el.onclick = null;
    let rem = sec;
    state.skipTimer = setInterval(() => {
      rem--;
      if (rem <= 0) {
        clearInterval(state.skipTimer);
        el.textContent = "✕";
        el.className = "bb-sr ready";
        el.onclick = () => BoostBoss.close();
      } else {
        el.textContent = rem;
      }
    }, 1000);
  }

  function startProgress(video, bar) {
    state.progressTimer = setInterval(() => {
      if (video.duration) bar.style.width = (video.currentTime / video.duration * 100) + "%";
    }, 200);
  }

  function clearTimers() {
    if (state.skipTimer) { clearInterval(state.skipTimer); state.skipTimer = null; }
    if (state.progressTimer) { clearInterval(state.progressTimer); state.progressTimer = null; }
  }

  // ── Public API ──
  const BoostBoss = {
    version: VERSION,

    init(opts) {
      Object.assign(config, opts || {});
      if (opts && opts.apiBase) {
        API_BASE = opts.apiBase.replace(/\/+$/, "");
      }
      injectStyles();
      state.initialized = true;
      console.log(`[BoostBoss SDK v${VERSION}] Initialized`, config.apiKey ? `key: ${config.apiKey.substr(0, 12)}...` : "(no key)", `→ ${API_BASE}`);
    },

    async requestAd(opts = {}) {
      if (!state.initialized) this.init({});

      // Check rate limit
      if (Date.now() - state.lastAdTime < config.minIntervalMs && state.adsShown > 0) {
        console.log("[BoostBoss] Rate limited — too soon");
        return null;
      }
      if (state.adsShown >= config.maxAdsPerSession) {
        console.log("[BoostBoss] Session ad cap reached");
        return null;
      }

      try {
        const resp = await fetch(`${API_BASE}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
              name: "get_sponsored_content",
              arguments: {
                context_summary: opts.context || "",
                user_region: opts.region || Intl.DateTimeFormat().resolvedOptions().timeZone,
                user_language: opts.language || navigator.language?.split("-")[0] || "en",
                session_id: SESSION_ID,
                developer_api_key: config.apiKey || "",
                format_preference: opts.format || "any",
              },
            },
          }),
        });

        const data = await resp.json();
        const text = data?.result?.content?.[0]?.text;
        if (!text) return null;

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (parseErr) {
          console.error("[BoostBoss] Failed to parse ad response:", parseErr);
          return null;
        }
        if (!parsed.sponsored) {
          console.log("[BoostBoss] No ad:", parsed.reason);
          return null;
        }

        const format = opts.format === "fullscreen" ? "fullscreen" : "corner";
        showAd(parsed.sponsored, format);
        return parsed.sponsored;
      } catch (err) {
        console.error("[BoostBoss] Error fetching ad:", err);
        return null;
      }
    },

    close() {
      const video = document.getElementById("bb-video");
      if (video) { video.pause(); video.removeAttribute("src"); }
      const popup = document.getElementById("bb-popup");
      if (popup) popup.style.display = "none";
      const backdrop = document.getElementById("bb-backdrop");
      if (backdrop) backdrop.style.display = "none";
      const pr = document.getElementById("bb-pr");
      if (pr) pr.style.width = "0%";
      clearTimers();
      if (state.currentAd) {
        track(state.currentAd.tracking?.close);
        if (config.onClose) config.onClose(state.currentAd);
      }
    },

    togglePlay() {
      const video = document.getElementById("bb-video");
      const overlay = document.getElementById("bb-vo");
      const pr = document.getElementById("bb-pr");
      if (!video) return;
      if (video.paused) {
        video.play(); overlay.style.display = "none"; startProgress(video, pr);
      } else {
        video.pause(); clearInterval(state.progressTimer); overlay.style.display = "flex"; document.getElementById("bb-pi").textContent = "▶";
      }
    },

    toggleMute() {
      const video = document.getElementById("bb-video");
      const btn = document.getElementById("bb-mb");
      if (!video) return;
      video.muted = !video.muted;
      btn.textContent = video.muted ? "🔇 Unmute" : "🔊 Mute";
    },

    getNativeAdHTML(ad) {
      return `<div class="bb-na">
        <div class="bb-nal"><span style="width:12px;height:12px;border-radius:3px;background:#FF2D78;display:inline-flex;align-items:center;justify-content:center;font-size:7px;color:#fff;font-weight:900;letter-spacing:-0.5px;">BB</span>Sponsored · Boost Boss</div>
        <div class="bb-nat">${ad.headline}</div>
        <div class="bb-nad">${ad.subtext}</div>
        <a class="bb-nac" href="${ad.cta_url}" target="_blank" onclick="BoostBoss._trackNative('${ad.tracking?.click}')">${ad.cta_label}</a>
      </div>`;
    },

    _trackNative(url) { track(url); },

    getStats() {
      return { session: SESSION_ID, adsShown: state.adsShown, lastAdTime: state.lastAdTime };
    },
  };

  // Auto-init from script tag data attributes
  const scripts = document.querySelectorAll('script[src*="sdk.js"]');
  for (const s of scripts) {
    const key = s.getAttribute("data-api-key");
    const base = s.getAttribute("data-api-base");
    if (key || base) {
      BoostBoss.init({ apiKey: key || null, apiBase: base || undefined });
      break;
    }
  }

  window.BoostBoss = BoostBoss;
})(window, document);
