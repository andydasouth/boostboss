/**
 * Boost Boss Conversion Pixel
 *
 * Single-file conversion-tracking script for advertisers. Once installed,
 * advertisers can fire conversions from their landing / thank-you page
 * without writing any tracking logic themselves.
 *
 * INSTALLATION (one snippet, paste before </head> on your conversion page):
 *
 *   <script async src="https://boostboss.ai/pixel.js"
 *           data-advertiser-id="adv_xxx"></script>
 *   <script>
 *     window.bbq = window.bbq || [];
 *     bbq.push(['track', 'signup', { value: 29.99, currency: 'USD' }]);
 *   </script>
 *
 * The pixel auto-detects the `bbx_auc` and `bbx_cmp` query params that
 * BBX appends to the click-through URL, so attribution back to the
 * winning auction is automatic.
 *
 * API:
 *   bbq.push(['init',  advertiserId])           // optional override of data-advertiser-id
 *   bbq.push(['track', conversionType, props])  // conversionType ∈ signup|purchase|tool_invoke|lead
 *
 * `props` may contain { value, currency, external_id }. Defaults: USD, no external_id.
 */
(function () {
  // Queue can already exist if the page used the standard snippet that
  // pushes commands before the script loads — drain it after init.
  var existingQueue = (window.bbq && window.bbq.length) ? window.bbq.slice() : [];
  var ENDPOINT = (window.__BBX_ENDPOINT__) || resolveOriginEndpoint() || 'https://boostboss.ai/api/track';
  var DEBUG    = !!window.__BBX_PIXEL_DEBUG__;

  function resolveOriginEndpoint() {
    // If pixel.js is loaded from a non-prod origin (staging / preview)
    // fire to the same origin so dev environments stay self-contained.
    try {
      var s = document.currentScript;
      if (!s) {
        var scripts = document.getElementsByTagName('script');
        for (var i = scripts.length - 1; i >= 0; i--) {
          if ((scripts[i].src || '').indexOf('/pixel.js') !== -1) { s = scripts[i]; break; }
        }
      }
      if (s && s.src) {
        var u = new URL(s.src, window.location.href);
        return u.origin + '/api/track';
      }
    } catch (_) {}
    return null;
  }

  // Read `bbx_auc` / `bbx_cmp` from the current URL or fall back to the
  // referrer (e.g. when the click landed on a page that then redirected
  // to a conversion page that stripped the query string).
  function readAttribution() {
    var out = { auction_id: null, campaign_id: null };
    function fromUrl(href) {
      try {
        var u = new URL(href);
        var auc = u.searchParams.get('bbx_auc');
        var cmp = u.searchParams.get('bbx_cmp');
        if (auc) out.auction_id  = auc;
        if (cmp) out.campaign_id = cmp;
      } catch (_) {}
    }
    fromUrl(window.location.href);
    if (!out.auction_id && document.referrer) fromUrl(document.referrer);
    // Persist to sessionStorage so a multi-step funnel (landing → signup
    // → success) can still attribute even after the URL is rewritten.
    try {
      if (out.auction_id) {
        sessionStorage.setItem('bbx_auc', out.auction_id);
        if (out.campaign_id) sessionStorage.setItem('bbx_cmp', out.campaign_id);
      } else {
        out.auction_id  = sessionStorage.getItem('bbx_auc');
        out.campaign_id = sessionStorage.getItem('bbx_cmp');
      }
    } catch (_) {}
    return out;
  }

  // Resolve the advertiser id from data-advertiser-id on the script tag,
  // a previously-pushed init command, or a window override.
  function readAdvertiserId() {
    if (window.__BBX_ADVERTISER_ID__) return String(window.__BBX_ADVERTISER_ID__);
    try {
      var s = document.currentScript || (function () {
        var scripts = document.getElementsByTagName('script');
        for (var i = scripts.length - 1; i >= 0; i--) {
          if ((scripts[i].src || '').indexOf('/pixel.js') !== -1) return scripts[i];
        }
        return null;
      })();
      if (s && s.getAttribute('data-advertiser-id')) {
        return s.getAttribute('data-advertiser-id');
      }
    } catch (_) {}
    return null;
  }

  function log() {
    if (!DEBUG) return;
    try { console.log.apply(console, ['[bbq]'].concat([].slice.call(arguments))); } catch (_) {}
  }

  function fire(conversionType, props) {
    var attr = readAttribution();
    if (!attr.campaign_id && !attr.auction_id) {
      log('no attribution — skipping. Pass bbx_auc/bbx_cmp in the click URL.');
      return;
    }
    if (!attr.campaign_id) {
      log('no campaign_id — pixel will fire but advertiser dashboard cannot attribute');
    }

    var body = {
      event:           'conversion',
      campaign_id:     attr.campaign_id,
      auction_id:      attr.auction_id,
      conversion_type: conversionType || 'signup',
      value:           (props && props.value != null) ? Number(props.value) : null,
      currency:        (props && props.currency) || 'USD',
      external_id:     (props && props.external_id) || null,
      session_id:      (props && props.session_id) || null,
    };

    log('firing conversion', body);
    // Use sendBeacon when available so the request survives nav-away
    // events on conversion pages that immediately redirect.
    var url  = ENDPOINT;
    var json = JSON.stringify(body);
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([json], { type: 'application/json' });
        var ok = navigator.sendBeacon(url, blob);
        if (ok) return;
      }
    } catch (_) {}
    try {
      fetch(url, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: json,
      }).catch(function () {});
    } catch (_) {}
  }

  // Public command processor. Each item is [verb, ...args].
  function process(cmd) {
    if (!Array.isArray(cmd) || cmd.length === 0) return;
    var verb = cmd[0];
    if (verb === 'init') {
      window.__BBX_ADVERTISER_ID__ = cmd[1];
    } else if (verb === 'track') {
      var conversionType = cmd[1];
      var props          = cmd[2] || {};
      fire(conversionType, props);
    }
  }

  // Replace the pre-load array stub with a real queue object whose
  // .push() runs the command synchronously. Drain anything queued
  // before the script loaded.
  var queue = { push: function (cmd) { process(cmd); } };
  window.bbq = queue;
  for (var i = 0; i < existingQueue.length; i++) process(existingQueue[i]);

  // Auto-init from data-advertiser-id if no explicit init command ran.
  if (!window.__BBX_ADVERTISER_ID__) {
    var adv = readAdvertiserId();
    if (adv) window.__BBX_ADVERTISER_ID__ = adv;
  }
})();
