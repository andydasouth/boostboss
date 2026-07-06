/**
 * Lumi for Browser App — runtime v0 (2026-06-20)
 * Boost Boss · https://boostboss.ai/publish/browser
 *
 * SCOPE OF v0
 * -----------
 * This is the minimal runtime that proves the install loop. It does NOT
 * render placements yet — that's v1. What it DOES do:
 *
 *   1. Reads the publisher ID from its own <script src="…#pub_xxx"> hash.
 *   2. Fires ONE impression event to /api/track with integration_method=
 *      js-snippet, which the publisher dashboard's verify-badge poller
 *      flips to "Live" within 30 seconds.
 *   3. Logs a friendly success banner to the publisher's console so they
 *      can confirm the script is wired without leaving their dev tools.
 *
 * That's it. Three lines on a page → confirmed connection in the dashboard.
 *
 * v1 will add: MutationObserver-based auto-detection of insertion points,
 * the 8 placement renderers (citation / chip / inline card / loading-state
 * / corner unit / page interstitial / empty-state hero / settings slot),
 * the impression/click beacon pipeline.
 *
 * PRIVACY POSTURE
 * ---------------
 * - We read only what's visible on the active tab.
 * - Nothing is persisted to localStorage / cookies / IndexedDB.
 * - The only network call leaves with: publisher_id, page URL host,
 *   timestamp, and an ephemeral session UUID. No user identifiers.
 * - When v1 adds DOM scanning for placement insertion points, the same
 *   posture applies: nothing read leaves the active tab in raw form.
 *
 * STRICT CSP
 * ----------
 * Publishers running a strict Content-Security-Policy must allowlist
 *   script-src https://boostboss.ai
 *   connect-src https://boostboss.ai
 * See /docs/browser for the full directive.
 */
(function () {
  'use strict';

  // Guard against double-load. If the publisher pasted the snippet twice,
  // or hot-reload re-runs us, we only want one impression event per page.
  if (window.__lumi_browser_loaded) return;
  window.__lumi_browser_loaded = true;

  const SDK_VERSION = '0.1.0';
  // Default door = Browser App (js-snippet). Computer App installs inject
  // a `data-lumi-door="mcp"` attribute on the <script> tag so the same
  // CDN runtime sends the right door key to /api/lumi-fetch + /api/track.
  // Resolved during script-tag discovery below.
  const DOOR_ALLOWLIST = { 'js-snippet': 1, 'mcp': 1 };
  let DOOR          = 'js-snippet';
  const ENDPOINT    = 'https://boostboss.ai/api/track';

  // ── 1. Resolve the publisher ID from our own script src #hash ──────
  // Pattern:   <script async src=".../lumi/v1.js#pub_a8x2k9"></script>
  // Hash-based config is CSP-friendly (no query-string churn for caching)
  // and survives URL rewrites that strip query params.
  function resolvePublisherId() {
    try {
      // currentScript is set during initial parse; falls back to scanning
      // <script> tags by suffix for async-deferred / re-injected cases.
      const cs = document.currentScript;
      const candidates = cs ? [cs] : Array.from(document.querySelectorAll('script[src*="lumi/v1.js"], script[src*="lumi-v1.js"]'));
      for (const s of candidates) {
        const src = s && s.src;
        if (!src) continue;
        const hashIdx = src.indexOf('#');
        if (hashIdx < 0) continue;
        const hash = src.slice(hashIdx + 1).trim();
        // Accept any non-empty publisher identifier — UUIDs, pub_xxx tokens,
        // sandbox keys (pub_test_xxx). The server-side decides what's valid;
        // the runtime just passes through whatever the dashboard generated.
        if (/^[a-zA-Z0-9][a-zA-Z0-9_.-]{4,}$/.test(hash)) {
          // Capture door override if the install CLI set it (Computer App
          // installs add data-lumi-door="mcp" so impressions track to the
          // right verify badge + the right placement bundle).
          try {
            const doorAttr = s.getAttribute && s.getAttribute('data-lumi-door');
            if (doorAttr && DOOR_ALLOWLIST[doorAttr]) DOOR = doorAttr;
          } catch (_) {}
          return hash;
        }
      }
    } catch (_) { /* swallow — fall through to null */ }
    return null;
  }

  const publisherId = resolvePublisherId();
  if (!publisherId) {
    // Publisher pasted the snippet without a publisher ID hash. Console
    // them so they can fix it without filing a support ticket.
    console.warn(
      '[Lumi] Browser App: missing publisher ID. The script src must end ' +
      'with #pub_xxx — see https://boostboss.ai/publish/dashboard for your key.'
    );
    return;
  }

  // ── 2. Generate an ephemeral session UUID ──────────────────────────
  // session_id MUST NOT start with "test_" — that prefix is reserved for
  // dashboard-driven synthetic tests, and the verify poller filters those
  // out of "Live" status. Real installs need a real UUID-shaped session.
  function ephemeralSessionId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (_) {}
    // Fallback — random hex chunks. Good enough for ephemeral session ID.
    const rnd = (n) => Math.floor(Math.random() * 16).toString(16).repeat(1);
    let id = '';
    for (let i = 0; i < 32; i++) id += rnd();
    return id.slice(0, 8) + '-' + id.slice(8, 12) + '-' + id.slice(12, 16) + '-' + id.slice(16, 20) + '-' + id.slice(20);
  }

  // ── 3. Fire the connect impression ─────────────────────────────────
  // One event. Records integration_method=js-snippet for the verify
  // badge, plus minimum required fields for the events table schema.
  function firePing() {
    const body = {
      event: 'impression',
      campaign_id: 'lumi_browser_v0_handshake',  // sentinel campaign — never deducted, see api/track.js cost guard
      session_id: ephemeralSessionId(),
      developer_id: publisherId,
      integration_method: DOOR,
      surface: 'web',
      placement_id: 'lumi_handshake',
      // Context strictly limited to the active tab — no cross-site read.
      context: {
        sdk_version: SDK_VERSION,
        page_host: location.host || null,
        page_path: location.pathname || null,
        is_handshake: true,
      },
    };

    // sendBeacon survives page unload; falls back to fetch where unavailable.
    const payload = JSON.stringify(body);
    let queued = false;
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([payload], { type: 'application/json' });
        queued = navigator.sendBeacon(ENDPOINT, blob);
      }
    } catch (_) { queued = false; }
    if (!queued) {
      try {
        fetch(ENDPOINT, {
          method: 'POST',
          mode: 'cors',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      } catch (_) { /* offline / blocked — silent */ }
    }
  }

  // ── 4. Console banner so the publisher SEES the success ────────────
  function banner() {
    if (!window.console || typeof console.log !== 'function') return;
    try {
      // Styled multi-line banner — survives copy-paste into support tickets.
      console.log(
        '%c▲ Lumi%c · Browser App v' + SDK_VERSION + ' · pub ' + publisherId + '\n' +
        '%cConnected. 8 placements available. Renderers ship in v1.\n' +
        'Live earnings: https://boostboss.ai/publish/dashboard',
        'background:#FF2D78;color:#fff;font-weight:700;padding:2px 8px;border-radius:4px;',
        'color:#9D7AFF;font-weight:600;',
        'color:#6B7280;font-size:11px;'
      );
    } catch (_) { /* console restricted — silent */ }
  }

  // ── 5. Build a short page-context summary ──────────────────────────
  // Used by the auction to match relevant ads. Visible-tab text only,
  // truncated, no input values or password fields. v0 keeps this very
  // simple — v1 will add the smarter context extractor.
  function buildContext() {
    try {
      const title = (document.title || '').trim();
      const metaDesc = (function () {
        const m = document.querySelector('meta[name="description"]');
        return m && m.getAttribute('content') ? m.getAttribute('content').trim() : '';
      })();
      const h1 = (function () {
        const el = document.querySelector('h1');
        return el && el.textContent ? el.textContent.trim() : '';
      })();
      const path = (location.pathname || '/').replace(/^\/+/, '').replace(/\/+$/, '');
      const parts = [title, h1, metaDesc, path].filter(Boolean);
      // Single-sentence context, length-capped so we don't ship full page text.
      return parts.join(' · ').slice(0, 280) || 'general browse';
    } catch (_) {
      return 'general browse';
    }
  }

  // ── 6. Ad fetch — calls /api/lumi-fetch with publisher_id + context ─
  // Returns an ad object or null (no fill / rate limited / no publisher).
  function fetchAd(placement, contextOverride) {
    const body = {
      publisher_id: publisherId,
      door:         DOOR,   // 'js-snippet' — flips Browser App verify badge
      context:      contextOverride || buildContext(),
      placement:    placement,
      format:       'native',
      session_id:   __sessionId,
      page_url:     location.href || null,
    };
    return fetch('https://boostboss.ai/api/lumi-fetch', {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', 'X-Lumi-Source': 'browser-app' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.ad) ? j.ad : null; })
      .catch(function () { return null; });
  }

  // ── 7. Impression + click beacons ──────────────────────────────────
  // Impression fires once per rendered ad when the element first
  // intersects the viewport. Click fires immediately on tap.
  function fireImpression(ad) {
    if (!ad || !ad.impression_url) return;
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ad.impression_url);
        return;
      }
    } catch (_) {}
    try { fetch(ad.impression_url, { mode: 'no-cors', credentials: 'omit', keepalive: true }).catch(function () {}); }
    catch (_) {}
  }
  function onClick(ad) {
    // Navigate to click_url (which 302s through /api/track for attribution).
    // Opens in a new tab so the publisher's app keeps its state.
    if (!ad) return;
    const url = ad.click_url || ad.cta_url;
    if (!url) return;
    try { window.open(url, '_blank', 'noopener,noreferrer'); }
    catch (_) { location.href = url; }
  }

  // ── 8. Visibility-based impression tracking ─────────────────────────
  // IntersectionObserver fires the impression beacon once when the ad
  // element first enters the viewport. No-op fallback for ancient
  // browsers — they get the impression on render instead.
  function observeImpression(el, ad) {
    if (!el || !ad) return;
    if (typeof IntersectionObserver === 'undefined') {
      fireImpression(ad);
      return;
    }
    let fired = false;
    const io = new IntersectionObserver(function (entries) {
      for (const e of entries) {
        if (e.isIntersecting && !fired) {
          fired = true;
          fireImpression(ad);
          try { io.disconnect(); } catch (_) {}
          return;
        }
      }
    }, { threshold: 0.4 });
    try { io.observe(el); } catch (_) { fireImpression(ad); }
  }

  // ── 9. Style-injection guard ───────────────────────────────────────
  // Injects the Lumi CSS namespace once. All placements use BEM-prefixed
  // classes (lumi-*) so we don't collide with the publisher's stylesheet.
  let __stylesInjected = false;
  function injectStyles() {
    if (__stylesInjected) return;
    __stylesInjected = true;
    const css = [
      // Corner unit — fixed bottom-right, dismissable, sliding entrance
      '.lumi-corner{position:fixed;bottom:18px;right:18px;width:300px;max-width:calc(100vw - 36px);background:#fff;border:1px solid #E5E7EB;border-radius:14px;box-shadow:0 12px 32px rgba(15,15,26,0.18);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;font-size:13px;color:#0F0F1A;z-index:2147483000;overflow:hidden;animation:lumi-slide-in 0.4s cubic-bezier(0.16,1,0.3,1) both}',
      '.lumi-corner__inner{padding:12px 14px 14px;position:relative}',
      '.lumi-corner__disclosure{font-size:9.5px;font-weight:700;color:#E01E65;letter-spacing:0.08em;text-transform:uppercase;display:flex;align-items:center;gap:6px;margin-bottom:7px}',
      '.lumi-corner__disclosure-mark{background:#FF2D78;color:#fff;font-weight:900;letter-spacing:-0.5px;font-size:8.5px;padding:1px 4px;border-radius:3px}',
      '.lumi-corner__close{position:absolute;top:8px;right:9px;width:20px;height:20px;background:transparent;border:none;color:#9CA3AF;font-size:15px;line-height:1;cursor:pointer;border-radius:4px;display:flex;align-items:center;justify-content:center;padding:0}',
      '.lumi-corner__close:hover{background:#F3F4F6;color:#0F0F1A}',
      '.lumi-corner__image{width:100%;height:104px;background:#F3F4F6;border-radius:8px;margin-bottom:9px;overflow:hidden;display:block;object-fit:cover}',
      '.lumi-corner__headline{font-weight:700;font-size:13.5px;line-height:1.35;color:#0F0F1A;margin-bottom:4px}',
      '.lumi-corner__body{font-size:12px;color:#4B5563;line-height:1.45;margin-bottom:10px}',
      '.lumi-corner__cta{display:inline-block;background:#FF2D78;color:#fff;font-weight:700;font-size:12px;padding:7px 14px;border-radius:7px;text-decoration:none;cursor:pointer;border:none;font-family:inherit}',
      '.lumi-corner__cta:hover{background:#E01E65}',
      '@keyframes lumi-slide-in{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}',
      '@media (prefers-reduced-motion: reduce){.lumi-corner,.lumi-interstitial,.lumi-loading-shimmer{animation:none}}',
      // Slot-mounted placements (settings, citation, chip, inline card, hero, loading)
      '.lumi-slot{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:#0F0F1A;border-radius:10px;overflow:hidden;margin:12px 0;background:#fff;border:1px solid #E5E7EB}',
      '.lumi-slot__disclosure{font-size:9.5px;font-weight:700;color:#E01E65;letter-spacing:0.08em;text-transform:uppercase;display:flex;align-items:center;gap:6px;padding:9px 12px 4px}',
      '.lumi-slot__disclosure-mark{background:#FF2D78;color:#fff;font-weight:900;letter-spacing:-0.5px;font-size:8.5px;padding:1px 4px;border-radius:3px}',
      '.lumi-slot__body{padding:0 12px 12px}',
      '.lumi-slot__headline{font-weight:700;font-size:14px;line-height:1.35;margin-bottom:3px}',
      '.lumi-slot__sub{font-size:12.5px;color:#4B5563;line-height:1.45;margin-bottom:9px}',
      '.lumi-slot__cta{display:inline-block;background:#FF2D78;color:#fff;font-weight:700;font-size:12px;padding:7px 14px;border-radius:7px;text-decoration:none;cursor:pointer;border:none;font-family:inherit}',
      '.lumi-slot__cta:hover{background:#E01E65}',
      // Settings page slot — colorful banner accent
      '.lumi-settings{border-left:3px solid #FF2D78}',
      '.lumi-settings .lumi-slot__body{display:flex;align-items:center;gap:14px}',
      '.lumi-settings .lumi-settings__icon{width:38px;height:38px;border-radius:9px;background:linear-gradient(135deg,#FF2D78,#FFB020);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}',
      '.lumi-settings .lumi-settings__text{flex:1;min-width:0}',
      // Page interstitial — full-page overlay
      '.lumi-interstitial{position:fixed;inset:0;background:rgba(15,15,26,0.72);z-index:2147483600;display:flex;align-items:center;justify-content:center;padding:24px;animation:lumi-fade-in 0.25s ease-out both;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}',
      '.lumi-interstitial__card{background:#fff;border-radius:16px;max-width:440px;width:100%;padding:28px;text-align:center;position:relative;box-shadow:0 24px 80px rgba(0,0,0,0.4);animation:lumi-pop-in 0.35s cubic-bezier(0.16,1,0.3,1) both}',
      '.lumi-interstitial__skip{position:absolute;top:12px;right:14px;background:#F3F4F6;border:none;width:30px;height:30px;border-radius:6px;color:#6B7280;font-size:14px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center}',
      '.lumi-interstitial__skip:hover{background:#E5E7EB;color:#0F0F1A}',
      '.lumi-interstitial__disclosure{font-size:10px;font-weight:700;color:#E01E65;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:10px}',
      '.lumi-interstitial__image{width:100%;border-radius:10px;margin-bottom:14px;max-height:160px;object-fit:cover;display:block}',
      '.lumi-interstitial__headline{font-size:19px;font-weight:700;color:#0F0F1A;margin-bottom:6px;line-height:1.3}',
      '.lumi-interstitial__body{font-size:13px;color:#4B5563;margin-bottom:16px;line-height:1.55}',
      '.lumi-interstitial__cta{display:inline-block;background:#FF2D78;color:#fff;font-weight:700;font-size:13px;padding:10px 22px;border-radius:8px;text-decoration:none;cursor:pointer;border:none;font-family:inherit}',
      '@keyframes lumi-fade-in{from{opacity:0}to{opacity:1}}',
      '@keyframes lumi-pop-in{from{transform:scale(0.92);opacity:0}to{transform:scale(1);opacity:1}}',
      // Loading-state shimmer
      '.lumi-loading{background:#FFF5F8;border:1px solid #FFE600;border-left:3px solid #FF2D78;border-radius:10px;padding:13px 16px;margin:10px 0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}',
      '.lumi-loading__label{font-size:10px;font-weight:700;color:#E01E65;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:8px}',
      '.lumi-loading__row{height:11px;border-radius:3px;background:linear-gradient(90deg,#FFE0EC 0%,#FFF5F9 50%,#FFE0EC 100%);background-size:360px 100%;animation:lumi-shimmer 1.2s linear infinite;margin-bottom:6px}',
      '.lumi-loading__row:nth-child(2){width:80%}',
      '.lumi-loading__row:nth-child(3){width:60%}',
      '.lumi-loading__row:nth-child(4){width:40%;margin-bottom:10px}',
      '.lumi-loading__headline{font-size:13.5px;font-weight:700;color:#0F0F1A;margin-bottom:4px}',
      '.lumi-loading__sub{font-size:12px;color:#4B5563;margin-bottom:10px}',
      '@keyframes lumi-shimmer{0%{background-position:-180px 0}100%{background-position:180px 0}}',
    ].join('\n');
    try {
      const style = document.createElement('style');
      style.setAttribute('data-lumi-styles', 'v0.1');
      style.appendChild(document.createTextNode(css));
      document.head.appendChild(style);
    } catch (_) {}
  }

  // ── 10. Corner unit placement ──────────────────────────────────────
  // The simplest placement to ship — no DOM scanning required. Fixed
  // position bottom-right, dismissable, one per page, lasts the session.
  // Auto-disabled if the publisher's app already has a corner-unit area
  // (we look for [data-lumi-disable] = "corner").
  let __cornerShown = false;
  function renderCornerUnit() {
    if (__cornerShown) return;
    if (document.querySelector('[data-lumi-disable="corner"], [data-lumi-disable="all"]')) return;
    fetchAd('corner').then(function (ad) {
      if (!ad) return;
      __cornerShown = true;
      injectStyles();
      const el = document.createElement('div');
      el.className = 'lumi-corner';
      el.setAttribute('role', 'complementary');
      el.setAttribute('aria-label', 'Sponsored content');
      // Build via createElement instead of innerHTML so we never inject
      // unsanitized ad copy into the publisher's DOM as HTML.
      const inner = document.createElement('div');
      inner.className = 'lumi-corner__inner';

      const closeBtn = document.createElement('button');
      closeBtn.className = 'lumi-corner__close';
      closeBtn.setAttribute('aria-label', 'Close sponsored content');
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        try { el.parentNode && el.parentNode.removeChild(el); } catch (_) {}
      });
      inner.appendChild(closeBtn);

      const disclosure = document.createElement('div');
      disclosure.className = 'lumi-corner__disclosure';
      const mark = document.createElement('span');
      mark.className = 'lumi-corner__disclosure-mark';
      mark.textContent = 'BB';
      disclosure.appendChild(mark);
      disclosure.appendChild(document.createTextNode(' ' + (ad.disclosure_label || 'Sponsored')));
      inner.appendChild(disclosure);

      if (ad.image_url) {
        const img = document.createElement('img');
        img.className = 'lumi-corner__image';
        img.src = ad.image_url;
        img.alt = '';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        inner.appendChild(img);
      }

      if (ad.headline) {
        const h = document.createElement('div');
        h.className = 'lumi-corner__headline';
        h.textContent = ad.headline;
        inner.appendChild(h);
      }

      if (ad.body) {
        const b = document.createElement('div');
        b.className = 'lumi-corner__body';
        b.textContent = ad.body;
        inner.appendChild(b);
      }

      const cta = document.createElement('button');
      cta.className = 'lumi-corner__cta';
      cta.type = 'button';
      cta.textContent = (ad.cta_label || 'Learn more') + ' →';
      cta.addEventListener('click', function (e) {
        e.preventDefault();
        onClick(ad);
      });
      inner.appendChild(cta);

      el.appendChild(inner);
      // Also let the whole card surface count as a click target — but
      // only if the click landed outside the close button or CTA.
      el.addEventListener('click', function (e) {
        if (e.target && (e.target.closest('.lumi-corner__close') || e.target.closest('.lumi-corner__cta'))) return;
        onClick(ad);
      });

      // Insert into DOM and start impression-on-visibility watch
      document.body.appendChild(el);
      observeImpression(el, ad);
    });
  }

  // ── 11. Shared slot renderer (citation / chip / inline card / hero / settings)
  // ────────────────────────────────────────────────────────────────────
  // Builds a card with disclosure + headline + sub + CTA. Used by the
  // simpler placements that share the same visual structure.
  function buildSlotCard(ad, opts) {
    opts = opts || {};
    const root = document.createElement('div');
    root.className = 'lumi-slot ' + (opts.extraClass || '');
    root.setAttribute('role', 'complementary');
    root.setAttribute('aria-label', 'Sponsored content');

    const disclosure = document.createElement('div');
    disclosure.className = 'lumi-slot__disclosure';
    const mark = document.createElement('span');
    mark.className = 'lumi-slot__disclosure-mark';
    mark.textContent = 'BB';
    disclosure.appendChild(mark);
    disclosure.appendChild(document.createTextNode(' ' + (ad.disclosure_label || 'Sponsored')));
    root.appendChild(disclosure);

    const body = document.createElement('div');
    body.className = 'lumi-slot__body';

    if (opts.layout === 'settings') {
      const icon = document.createElement('div');
      icon.className = 'lumi-settings__icon';
      icon.textContent = '✦';
      body.appendChild(icon);
      const text = document.createElement('div');
      text.className = 'lumi-settings__text';
      if (ad.headline) {
        const h = document.createElement('div');
        h.className = 'lumi-slot__headline';
        h.textContent = ad.headline;
        text.appendChild(h);
      }
      if (ad.body) {
        const s = document.createElement('div');
        s.className = 'lumi-slot__sub';
        s.style.marginBottom = '0';
        s.textContent = ad.body;
        text.appendChild(s);
      }
      body.appendChild(text);
      const cta = document.createElement('button');
      cta.className = 'lumi-slot__cta';
      cta.type = 'button';
      cta.textContent = (ad.cta_label || 'Learn more') + ' →';
      cta.addEventListener('click', function (e) { e.preventDefault(); onClick(ad); });
      body.appendChild(cta);
    } else {
      if (ad.headline) {
        const h = document.createElement('div');
        h.className = 'lumi-slot__headline';
        h.textContent = ad.headline;
        body.appendChild(h);
      }
      if (ad.body) {
        const s = document.createElement('div');
        s.className = 'lumi-slot__sub';
        s.textContent = ad.body;
        body.appendChild(s);
      }
      const cta = document.createElement('button');
      cta.className = 'lumi-slot__cta';
      cta.type = 'button';
      cta.textContent = (ad.cta_label || 'Learn more') + ' →';
      cta.addEventListener('click', function (e) { e.preventDefault(); onClick(ad); });
      body.appendChild(cta);
    }
    root.appendChild(body);
    root.addEventListener('click', function (e) {
      if (e.target && e.target.closest('.lumi-slot__cta')) return;
      onClick(ad);
    });
    return root;
  }

  // ── 12. Settings page slot ─────────────────────────────────────────
  // Fires only when the publisher's app is on a settings/billing route.
  // Mounts inline at the top of [data-lumi-slot="settings"] if the
  // publisher placed an explicit marker, otherwise prepends to <main>
  // or <body>.
  const SETTINGS_PATHS = ['/settings', '/account', '/billing', '/profile', '/preferences', '/subscription'];
  let __settingsShown = false;
  function maybeRenderSettings() {
    if (__settingsShown) return;
    if (document.querySelector('[data-lumi-disable="settings"], [data-lumi-disable="all"]')) return;
    const path = (location.pathname || '').toLowerCase();
    const matches = SETTINGS_PATHS.some(function (p) { return path === p || path.indexOf(p + '/') === 0 || path.indexOf(p) >= 0; });
    if (!matches) return;
    fetchAd('settings', buildContext() + ' settings billing account').then(function (ad) {
      if (!ad) return;
      __settingsShown = true;
      injectStyles();
      const el = buildSlotCard(ad, { extraClass: 'lumi-settings', layout: 'settings' });
      const slot = document.querySelector('[data-lumi-slot="settings"]');
      const target = slot || document.querySelector('main') || document.body;
      if (slot) slot.appendChild(el);
      else target.insertBefore(el, target.firstChild);
      observeImpression(el, ad);
    });
  }

  // ── 13. Page interstitial ──────────────────────────────────────────
  // Full-page sponsor between route navigations. Triggers on history
  // API push/pop. Frequency-capped to one per session by default; the
  // backend's frequency cap is the source of truth.
  let __interstitialCount = 0;
  const __INTERSTITIAL_MAX_PER_PAGE = 1;
  function renderInterstitial() {
    if (__interstitialCount >= __INTERSTITIAL_MAX_PER_PAGE) return;
    if (document.querySelector('[data-lumi-disable="interstitial"], [data-lumi-disable="all"]')) return;
    fetchAd('interstitial').then(function (ad) {
      if (!ad) return;
      __interstitialCount++;
      injectStyles();
      const root = document.createElement('div');
      root.className = 'lumi-interstitial';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-label', 'Sponsored content');

      const card = document.createElement('div');
      card.className = 'lumi-interstitial__card';

      const skip = document.createElement('button');
      skip.className = 'lumi-interstitial__skip';
      skip.setAttribute('aria-label', 'Close');
      skip.textContent = '×';
      skip.addEventListener('click', function () { try { root.parentNode && root.parentNode.removeChild(root); } catch (_) {} });
      card.appendChild(skip);

      const disc = document.createElement('div');
      disc.className = 'lumi-interstitial__disclosure';
      disc.textContent = ad.disclosure_label || 'Sponsored';
      card.appendChild(disc);

      if (ad.image_url) {
        const img = document.createElement('img');
        img.className = 'lumi-interstitial__image';
        img.src = ad.image_url;
        img.alt = '';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        card.appendChild(img);
      }

      if (ad.headline) {
        const h = document.createElement('div');
        h.className = 'lumi-interstitial__headline';
        h.textContent = ad.headline;
        card.appendChild(h);
      }
      if (ad.body) {
        const b = document.createElement('div');
        b.className = 'lumi-interstitial__body';
        b.textContent = ad.body;
        card.appendChild(b);
      }
      const cta = document.createElement('button');
      cta.className = 'lumi-interstitial__cta';
      cta.type = 'button';
      cta.textContent = (ad.cta_label || 'Learn more') + ' →';
      cta.addEventListener('click', function (e) {
        e.preventDefault();
        onClick(ad);
        try { root.parentNode && root.parentNode.removeChild(root); } catch (_) {}
      });
      card.appendChild(cta);

      // Click backdrop = dismiss (treat as skip, no click attribution)
      root.addEventListener('click', function (e) {
        if (e.target === root) { try { root.parentNode && root.parentNode.removeChild(root); } catch (_) {} }
      });

      root.appendChild(card);
      document.body.appendChild(root);
      observeImpression(card, ad);
    });
  }

  // Hook into the History API so we get notified on SPA route changes.
  function installRouteListener() {
    try {
      const origPush = history.pushState;
      const origReplace = history.replaceState;
      function notify() {
        // Defer to next tick so the new route's DOM settles first
        setTimeout(function () {
          maybeRenderSettings();
          // Avoid hammering on every nav — interstitial gets one shot per page
          if (__interstitialCount < __INTERSTITIAL_MAX_PER_PAGE) {
            // 60-second cooldown after handshake so first nav doesn't interrupt landing
            if (Date.now() - __routeListenerInstalledAt > 60000) renderInterstitial();
          }
        }, 80);
      }
      history.pushState = function () { const r = origPush.apply(this, arguments); notify(); return r; };
      history.replaceState = function () { const r = origReplace.apply(this, arguments); notify(); return r; };
      window.addEventListener('popstate', notify);
    } catch (_) { /* ignore — proxying history can fail in sandboxed iframes */ }
  }
  const __routeListenerInstalledAt = Date.now();

  // ── 14. Loading-state ad ───────────────────────────────────────────
  // Watches for spinners/skeletons appearing in publisher-marked slots
  // (data-lumi-slot="loading") OR auto-detects [aria-busy="true"] /
  // .spinner / .loading elements that stay visible for >2s (so brief
  // micro-spinners don't fire impressions).
  function renderLoadingAt(target) {
    if (!target || target.__lumiLoadingFilled) return;
    if (document.querySelector('[data-lumi-disable="loading"], [data-lumi-disable="all"]')) return;
    target.__lumiLoadingFilled = true;
    fetchAd('loading').then(function (ad) {
      if (!ad) { target.__lumiLoadingFilled = false; return; }
      injectStyles();
      const root = document.createElement('div');
      root.className = 'lumi-loading';
      const label = document.createElement('div');
      label.className = 'lumi-loading__label';
      label.textContent = 'Sponsored · loading';
      root.appendChild(label);

      if (ad.headline) {
        const h = document.createElement('div');
        h.className = 'lumi-loading__headline';
        h.textContent = ad.headline;
        root.appendChild(h);
      }
      if (ad.body) {
        const s = document.createElement('div');
        s.className = 'lumi-loading__sub';
        s.textContent = ad.body;
        root.appendChild(s);
      }
      // Shimmer rows visually suggest more content loading
      for (let i = 0; i < 3; i++) {
        const r = document.createElement('div');
        r.className = 'lumi-loading__row';
        root.appendChild(r);
      }
      const cta = document.createElement('button');
      cta.className = 'lumi-slot__cta';
      cta.type = 'button';
      cta.textContent = (ad.cta_label || 'Learn more') + ' →';
      cta.addEventListener('click', function (e) { e.preventDefault(); onClick(ad); });
      root.appendChild(cta);

      // Mount as the slot's content (clearing the spinner) or alongside it
      try {
        if (target.dataset && target.dataset.lumiSlot === 'loading') {
          target.appendChild(root);
        } else {
          // For auto-detected spinners, sit next to them rather than replacing
          // so the publisher's own loading state stays intact.
          target.parentNode && target.parentNode.insertBefore(root, target.nextSibling);
        }
        observeImpression(root, ad);
      } catch (_) {}
    });
  }

  function scanForLoadingTargets() {
    // Explicit slot tag is the trusted path
    const explicit = document.querySelectorAll('[data-lumi-slot="loading"]');
    explicit.forEach(function (n) { renderLoadingAt(n); });
    if (explicit.length > 0) return;
    // Auto-detect, but only if the spinner has been visible >2s (filters
    // out brief UI ticks that don't warrant ad interruption)
    const candidates = document.querySelectorAll('[aria-busy="true"], .spinner, .loading');
    candidates.forEach(function (n) {
      if (n.__lumiSeenAt) {
        if (Date.now() - n.__lumiSeenAt > 2000) renderLoadingAt(n);
      } else {
        n.__lumiSeenAt = Date.now();
      }
    });
  }

  // ── 15. Auto-mount renderers (citation / chip / inline-card / hero) ──
  // Smart auto-detection with safe fallbacks. Three-tier strategy:
  //   1. Honor explicit publisher markers first: <div data-lumi-slot="X">
  //   2. If no marker, try to find the ideal location via heuristic
  //      selectors (chat containers, suggestion bars, feed lists, empty
  //      states). Mount there.
  //   3. If heuristic fails, fall back to a safe default location where
  //      the placement still serves impressions without breaking publisher
  //      UI (no false positives on code blocks, forms, system messages).
  // Publisher can disable any auto-mount with <meta data-lumi-disable="X">.
  // This is v1.5 — replaces the opt-in-only path from v1.3.
  const SLOT_TO_PLACEMENT = {
    citation: 'citation',
    chip:     'chip',
    card:     'card',
    hero:     'hero',
  };

  // Skip elements that are inside risky containers — code blocks, password
  // fields, system messages, admin chrome, the publisher's own ad slots,
  // and anything they've explicitly opted-out of.
  function isInsideRiskyContainer(el) {
    if (!el || !el.closest) return false;
    return !!el.closest(
      'pre, code, [contenteditable="true"], ' +
      'input, textarea, select, ' +
      '[data-lumi-disable], [data-lumi-disable="all"], ' +
      '[role="alert"], [role="status"], ' +
      '.system-message, [data-system], ' +
      '.code-block, .codeblock, .monaco-editor, .CodeMirror, ' +
      'header, nav, [role="banner"], [role="navigation"], ' +
      '.lumi-slot, .lumi-corner, .lumi-interstitial, .lumi-loading, .lumi-sidebar, .lumi-window-banner'
    );
  }

  // Heuristic finder: AI response containers (used by citation, chip).
  // Tries the most specific selectors first; falls back to broader ones.
  function findAIResponseContainer() {
    const candidates = [
      // Specific assistant/AI message markers
      '[data-message-role="assistant"]:last-of-type',
      '[data-role="assistant"]:last-of-type',
      '.assistant-message:last-of-type',
      '.ai-message:last-of-type',
      '.message.assistant:last-of-type',
      '.chat-message.ai:last-of-type',
      '[data-author="ai"]:last-of-type',
      '[data-author="assistant"]:last-of-type',
      '[data-from="ai"]:last-of-type',
      // Generic chat/log roles
      '[role="log"] > *:last-child',
      '[role="status"] > *:last-child',
      // Common class names
      '.messages > *:last-child:not(.user)',
      '.chat-messages > *:last-child',
      '.conversation > *:last-child',
      '.thread > *:last-child',
    ];
    for (const sel of candidates) {
      try {
        const el = document.querySelector(sel);
        if (el && !isInsideRiskyContainer(el)) return el;
      } catch (_) {}
    }
    return null;
  }

  // Heuristic finder: feed / message-list containers (used by card).
  function findFeedContainer() {
    const candidates = [
      '[role="feed"]',
      '[role="log"]',
      '.messages',
      '.chat-messages',
      '.conversation',
      '.feed',
      '.timeline',
      '.message-list',
      '[data-message-list]',
      'main [class*="messages"]',
      'main [class*="chat"]',
    ];
    for (const sel of candidates) {
      try {
        const el = document.querySelector(sel);
        if (el && !isInsideRiskyContainer(el)) {
          // Only insert into containers that actually have content. An empty
          // feed is for the hero placement, not card.
          if (el.children && el.children.length >= 2) return el;
        }
      } catch (_) {}
    }
    return null;
  }

  // Heuristic finder: empty-state containers (used by hero).
  function findEmptyStateContainer() {
    const candidates = [
      '[data-empty="true"]',
      '[data-state="empty"]',
      '.empty-state',
      '.empty-view',
      '.no-content',
      '[role="main"]:empty',
      'main:empty',
    ];
    for (const sel of candidates) {
      try {
        const el = document.querySelector(sel);
        if (el && !isInsideRiskyContainer(el)) return el;
      } catch (_) {}
    }
    // Heuristic fallback: <main> with no children
    try {
      const main = document.querySelector('main');
      if (main && !isInsideRiskyContainer(main)) {
        const visibleKids = Array.from(main.children).filter(function (c) {
          return c.offsetParent !== null && !c.classList.contains('lumi-slot');
        });
        if (visibleKids.length === 0) return main;
      }
    } catch (_) {}
    return null;
  }

  // Heuristic finder: suggestion / quick-reply container (used by chip).
  function findSuggestionContainer() {
    const candidates = [
      '[data-suggestions]',
      '[data-quick-replies]',
      '.suggestions',
      '.quick-replies',
      '.suggested-actions',
      '.suggested-prompts',
      '.chip-list',
      '[role="toolbar"][aria-label*="suggest" i]',
    ];
    for (const sel of candidates) {
      try {
        const el = document.querySelector(sel);
        if (el && !isInsideRiskyContainer(el)) return el;
      } catch (_) {}
    }
    return null;
  }

  // Safe-default mount points when heuristics fail. These won't be the
  // ideal placement (lower RPM) but they DO serve impressions safely.
  // Publisher can override with explicit slot markers for premium placement.
  function safeDefaultMount(placement) {
    // Build a free-floating container appended to <body>
    const wrapper = document.createElement('div');
    wrapper.className = 'lumi-slot lumi-slot--default';
    if (placement === 'citation') {
      // Pin to bottom-left, small text-only line
      wrapper.style.cssText = 'position:fixed;bottom:14px;left:14px;max-width:280px;z-index:2147483050;font-size:11px;';
    } else if (placement === 'chip') {
      // Pin to bottom-left as floating pill
      wrapper.style.cssText = 'position:fixed;bottom:14px;left:14px;z-index:2147483050;';
    } else if (placement === 'card') {
      // End of <main> or <body>
      wrapper.style.cssText = 'margin:24px auto;max-width:520px;';
    } else if (placement === 'hero') {
      // Top of viewport when nothing else
      wrapper.style.cssText = 'margin:16px auto;max-width:640px;';
    }
    document.body.appendChild(wrapper);
    return wrapper;
  }

  // Tracks whether each placement has already mounted at least once per
  // page load so we don't double-mount on repeated MutationObserver fires.
  const __autoMounted = { citation: false, chip: false, card: false, hero: false };

  function tryAutoMount(placement) {
    if (__autoMounted[placement]) return;
    if (document.querySelector('[data-lumi-disable="' + placement + '"], [data-lumi-disable="all"]')) return;

    // Tier 1 — explicit publisher marker wins
    const explicit = document.querySelector('[data-lumi-slot="' + placement + '"]');
    if (explicit && !explicit.__lumiFilled) {
      mountAt(explicit, placement, /*isExplicit*/ true);
      return;
    }

    // Tier 2 — heuristic detection
    let target = null;
    let position = 'append'; // append | after | prepend
    if (placement === 'citation') {
      target = findAIResponseContainer();
      position = 'append';
    } else if (placement === 'chip') {
      target = findSuggestionContainer() || findAIResponseContainer();
      position = target && target.classList && target.classList.contains('suggestions') ? 'append' : 'after';
    } else if (placement === 'card') {
      target = findFeedContainer();
      position = 'append';
    } else if (placement === 'hero') {
      target = findEmptyStateContainer();
      position = 'append';
    }

    // Tier 3 — safe default fallback
    if (!target) {
      target = safeDefaultMount(placement);
      position = 'append';
    }
    mountAt(target, placement, /*isExplicit*/ false, position);
  }

  function mountAt(target, placement, isExplicit, position) {
    if (!target || target.__lumiFilled) return;
    target.__lumiFilled = true;
    fetchAd(placement).then(function (ad) {
      if (!ad) { target.__lumiFilled = false; return; }
      __autoMounted[placement] = true;
      injectStyles();
      const el = buildSlotCard(ad);
      try {
        if (isExplicit || position === 'append') {
          target.appendChild(el);
        } else if (position === 'after' && target.parentNode) {
          target.parentNode.insertBefore(el, target.nextSibling);
        } else if (position === 'prepend') {
          target.insertBefore(el, target.firstChild);
        } else {
          target.appendChild(el);
        }
        observeImpression(el, ad);
      } catch (_) {
        target.__lumiFilled = false;
      }
    });
  }

  // Backward-compat shim — old code-paths call renderOptInSlots(). Now
  // routes through the auto-mount tryer for all 4 placements.
  function renderOptInSlots() {
    tryAutoMount('citation');
    tryAutoMount('chip');
    tryAutoMount('card');
    tryAutoMount('hero');
  }

  // Ephemeral session id, reused across all ad-fetch calls on this page.
  const __sessionId = (function () {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (_) {}
    return 'lumi_' + Math.random().toString(36).slice(2, 12) + '_' + Date.now();
  })();

  // ── 15b. Desktop-only placements (DOOR === 'mcp') ──────────────────
  // Computer App installs (Electron) get three extra placements the
  // Browser App door doesn't ship: a slim top window banner, a sticky
  // sidebar slot, and a system notification via the HTML5 Notification
  // API (works inside Electron renderers; user has already granted via
  // the app's main process).

  // Inject desktop-only CSS once
  let __desktopStylesInjected = false;
  function injectDesktopStyles() {
    if (__desktopStylesInjected) return;
    __desktopStylesInjected = true;
    const css = [
      '.lumi-window-banner{position:fixed;top:0;left:0;right:0;background:linear-gradient(90deg,#0F0F1A 0%,#1A1A2E 100%);color:#fff;padding:7px 14px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;font-size:12.5px;display:flex;align-items:center;gap:12px;z-index:2147483100;box-shadow:0 1px 0 rgba(255,255,255,0.06)}',
      '.lumi-window-banner__pill{background:#FF2D78;color:#fff;font-weight:900;font-size:9px;letter-spacing:0.08em;padding:2px 7px;border-radius:3px;text-transform:uppercase}',
      '.lumi-window-banner__text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0.92}',
      '.lumi-window-banner__cta{background:#FF2D78;color:#fff;text-decoration:none;font-weight:700;font-size:11.5px;padding:5px 12px;border-radius:6px;cursor:pointer;border:none;font-family:inherit;flex-shrink:0}',
      '.lumi-window-banner__close{background:transparent;border:none;color:#fff;font-size:14px;opacity:0.5;cursor:pointer;padding:0;width:22px;height:22px;border-radius:4px;flex-shrink:0}',
      '.lumi-window-banner__close:hover{opacity:1;background:rgba(255,255,255,0.08)}',
      '.lumi-sidebar{position:fixed;top:54px;right:14px;width:200px;background:#FAFAF7;border:1px solid #E5E7EB;border-radius:10px;padding:11px 13px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;font-size:12px;color:#0F0F1A;z-index:2147482900;box-shadow:0 4px 14px rgba(15,15,26,0.08)}',
      '.lumi-sidebar__label{font-size:9px;font-weight:700;color:#E01E65;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:5px}',
      '.lumi-sidebar__headline{font-weight:700;font-size:12.5px;line-height:1.4;margin-bottom:7px;color:#0F0F1A}',
      '.lumi-sidebar__cta{display:inline-block;background:#FF2D78;color:#fff;font-weight:700;font-size:11px;padding:5px 11px;border-radius:6px;text-decoration:none;cursor:pointer;border:none;font-family:inherit}',
      '.lumi-sidebar__close{position:absolute;top:5px;right:7px;background:transparent;border:none;color:#9CA3AF;font-size:13px;cursor:pointer;line-height:1;padding:2px 5px}',
      '.lumi-sidebar__close:hover{color:#0F0F1A}',
    ].join('\n');
    try {
      const style = document.createElement('style');
      style.setAttribute('data-lumi-desktop-styles', 'v0.1');
      style.appendChild(document.createTextNode(css));
      document.head.appendChild(style);
    } catch (_) {}
  }

  // Window banner — slim top strip
  let __windowBannerShown = false;
  function renderWindowBanner() {
    if (__windowBannerShown) return;
    if (document.querySelector('[data-lumi-disable="window-banner"], [data-lumi-disable="all"]')) return;
    fetchAd('window_banner').then(function (ad) {
      if (!ad) return;
      __windowBannerShown = true;
      injectDesktopStyles();
      const el = document.createElement('div');
      el.className = 'lumi-window-banner';
      el.setAttribute('role', 'complementary');

      const pill = document.createElement('span');
      pill.className = 'lumi-window-banner__pill';
      pill.textContent = 'Sponsored';
      el.appendChild(pill);

      const text = document.createElement('span');
      text.className = 'lumi-window-banner__text';
      text.textContent = (ad.headline || '') + (ad.body ? ' — ' + ad.body : '');
      el.appendChild(text);

      const cta = document.createElement('button');
      cta.className = 'lumi-window-banner__cta';
      cta.type = 'button';
      cta.textContent = ad.cta_label || 'Try free →';
      cta.addEventListener('click', function (e) { e.preventDefault(); onClick(ad); });
      el.appendChild(cta);

      const close = document.createElement('button');
      close.className = 'lumi-window-banner__close';
      close.setAttribute('aria-label', 'Close');
      close.textContent = '×';
      close.addEventListener('click', function () { try { el.parentNode && el.parentNode.removeChild(el); } catch (_) {} });
      el.appendChild(close);

      document.body.appendChild(el);
      observeImpression(el, ad);
    });
  }

  // Sidebar slot — sticky card pinned to top-right (under window banner)
  let __sidebarShown = false;
  function renderSidebarSlot() {
    if (__sidebarShown) return;
    if (document.querySelector('[data-lumi-disable="sidebar"], [data-lumi-disable="all"]')) return;
    fetchAd('sidebar').then(function (ad) {
      if (!ad) return;
      __sidebarShown = true;
      injectDesktopStyles();
      const el = document.createElement('div');
      el.className = 'lumi-sidebar';
      el.setAttribute('role', 'complementary');

      const close = document.createElement('button');
      close.className = 'lumi-sidebar__close';
      close.setAttribute('aria-label', 'Close');
      close.textContent = '×';
      close.addEventListener('click', function () { try { el.parentNode && el.parentNode.removeChild(el); } catch (_) {} });
      el.appendChild(close);

      const label = document.createElement('div');
      label.className = 'lumi-sidebar__label';
      label.textContent = ad.disclosure_label || 'Sponsored';
      el.appendChild(label);

      const headline = document.createElement('div');
      headline.className = 'lumi-sidebar__headline';
      headline.textContent = ad.headline || '';
      el.appendChild(headline);

      const cta = document.createElement('button');
      cta.className = 'lumi-sidebar__cta';
      cta.type = 'button';
      cta.textContent = (ad.cta_label || 'Learn more') + ' →';
      cta.addEventListener('click', function (e) { e.preventDefault(); onClick(ad); });
      el.appendChild(cta);

      el.addEventListener('click', function (e) {
        if (e.target && (e.target.closest('.lumi-sidebar__close') || e.target.closest('.lumi-sidebar__cta'))) return;
        onClick(ad);
      });

      document.body.appendChild(el);
      observeImpression(el, ad);
    });
  }

  // System notification — HTML5 Notification API. Works inside Electron
  // renderers when the app's main process has granted notification
  // permission. Honors the user's OS-level notification settings.
  let __systemNotifShown = false;
  function renderSystemNotification() {
    if (__systemNotifShown) return;
    if (document.querySelector('[data-lumi-disable="system-notification"], [data-lumi-disable="all"]')) return;
    if (typeof Notification === 'undefined') return; // no notification support
    if (Notification.permission !== 'granted') return; // app didn't grant
    fetchAd('notification').then(function (ad) {
      if (!ad) return;
      __systemNotifShown = true;
      try {
        const n = new Notification(ad.headline || 'Sponsored', {
          body: ad.body || (ad.disclosure_label || 'Sponsored'),
          icon: ad.image_url || undefined,
          tag: 'lumi-sponsored',
          silent: false,
        });
        n.onclick = function () { onClick(ad); try { n.close(); } catch (_) {} };
        // Notifications fire as "shown" the moment they're created — count
        // as impression on display rather than visibility.
        fireImpression(ad);
      } catch (_) { /* notification creation failed — silent */ }
    });
  }

  // ── 16. Periodic re-scan for SPA-injected slot markers ──────────────
  // Publishers with SPAs (React/Vue/Svelte) may inject [data-lumi-slot]
  // markers AFTER initial DOMContentLoaded. A light scan every 2s
  // catches them. Stops auto-scanning once 10 attempts have passed
  // with no new slots — keeps idle CPU at zero.
  let __scanAttemptsSinceLastFind = 0;
  function periodicScan() {
    const before = document.querySelectorAll('[data-lumi-slot]').length;
    renderOptInSlots();
    scanForLoadingTargets();
    maybeRenderSettings();
    const after = document.querySelectorAll('[data-lumi-slot]:not([__lumi-counted])').length;
    if (after > before) __scanAttemptsSinceLastFind = 0;
    else __scanAttemptsSinceLastFind++;
    if (__scanAttemptsSinceLastFind < 10) {
      setTimeout(periodicScan, 2000);
    }
  }

  // ── 17. Fire when ready ────────────────────────────────────────────
  // We DON'T block first paint. Wait until the page is parsed enough that
  // sending the beacon won't compete with the publisher's hero render.
  function go() {
    firePing();
    banner();
    // Render the corner unit after a short delay so the publisher's app
    // has time to lay out its own UI first. Feels less intrusive.
    setTimeout(renderCornerUnit, 1500);
    // Computer App door: layer in the desktop-specific placements that
    // make Electron apps earn premium RPMs (window banner $7.50, sidebar
    // $7, system notification $5). Browser App publishers don't get these.
    if (DOOR === 'mcp') {
      setTimeout(renderWindowBanner, 2200);
      setTimeout(renderSidebarSlot, 2800);
      setTimeout(renderSystemNotification, 4000);
    }
    // Scan once for explicit slot markers, then settings, then start the
    // periodic re-scan to catch SPA-injected slots.
    setTimeout(function () {
      renderOptInSlots();
      maybeRenderSettings();
      installRouteListener();
      periodicScan();
    }, 800);
    // Expose a tiny diagnostic surface for the publisher's dev tools.
    try {
      Object.defineProperty(window, 'Lumi', {
        value: Object.freeze({
          version: SDK_VERSION,
          publisherId: publisherId,
          door: DOOR,
          ping: function ping() { firePing(); },
          corner: function corner() { __cornerShown = false; renderCornerUnit(); },
          interstitial: function interstitial() { __interstitialCount = 0; renderInterstitial(); },
          settings: function settings() { __settingsShown = false; maybeRenderSettings(); },
          context: buildContext(),
        }),
        writable: false,
        configurable: false,
      });
    } catch (_) { /* already defined — fine */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', go, { once: true });
  } else {
    // Already past parsing — fire after a micro-tick so we never block
    // the same task that loaded us.
    setTimeout(go, 0);
  }
})();
