/**
 * Boost Boss dashboard — dark-theme normalizer
 *
 * The dashboards were built light-themed with hundreds of inconsistent
 * hardcoded light colors (many with higher CSS specificity than any override
 * can beat, plus body-level modals a scoped stylesheet can't reach). This
 * walks the DOM and, for any light-background element in the content/modals,
 * sets an inline dark background (inline styles win over class rules) and
 * lightens dark text so it stays readable. Ad-preview mockups are excluded —
 * they simulate real ads and must stay light. Runs on load, on route change,
 * and whenever the app adds nodes (modals, JS-rendered cards).
 */
(function () {
  var CARD = '#1B1D22', FIELD = '#1E2024', INK = '#E7E9EA',
      MUTED = '#9DA3A6', BORDER = 'rgba(255,255,255,0.10)';

  function lum(c) {
    var m = c && c.match(/rgba?\(([^)]+)\)/);
    if (!m) return -1;
    var p = m[1].split(',').map(Number);
    if (p.length >= 4 && p[3] < 0.35) return -1; // transparent
    return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  }

  // Elements/subtrees to leave alone: the (already-dark) shell chrome, the
  // branded modal, and every ad-preview / mockup / wireframe surface.
  var EXCLUDE = '.shell-sidebar,.shell-topbar,.bbm-backdrop,' +
    '[class*="preview"],[class*="pl-preview"],[class*="pl-card"],[class*="wf-"],' +
    '[class*="ad-card"],[class*="ad-preview"],[class*="mock"],[class*="sponsor"],' +
    '[class*="tryit"],[class*="scene"],[class*="creative-preview"]';
  var SKIP_TAGS = { IMG: 1, SVG: 1, PATH: 1, VIDEO: 1, CANVAS: 1, IFRAME: 1 };

  function normalize() {
    var els = document.body.getElementsByTagName('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (SKIP_TAGS[el.tagName]) continue;
      if (el.closest && el.closest(EXCLUDE)) continue;
      var cs = getComputedStyle(el);

      // --- light background → dark (once per element) ---
      if (!el.dataset.bbDk) {
        var L = lum(cs.backgroundColor);
        if (L >= 208) {
          var field = (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
          el.style.setProperty('background', field ? FIELD : CARD, 'important');
          if (lum(cs.borderTopColor) > 180) el.style.setProperty('border-color', BORDER, 'important');
          el.dataset.bbDk = '1';
        }
      }

      // --- dark text → readable light (self-limiting: once lightened it
      //     no longer matches, so this never loops) ---
      var tl = lum(cs.color);
      if (tl >= 0 && tl < 105) el.style.setProperty('color', INK, 'important');
      else if (tl >= 105 && tl < 150) el.style.setProperty('color', MUTED, 'important');

      // --- define card frames: a card-sized rounded panel with a dark fill
      //     but no visible border melts into the dark page — give it a subtle
      //     border so the frame reads. Once per element. ---
      if (!el.dataset.bbFr) {
        var rad = parseFloat(cs.borderTopLeftRadius) || 0;
        if (rad >= 9) {
          var bgl = lum(cs.backgroundColor);
          if (bgl >= 0 && bgl < 70) { // has a dark fill = a panel (not transparent)
            var rr = el.getBoundingClientRect();
            if (rr.width >= 200 && rr.height >= 56) {
              var bw = parseFloat(cs.borderTopWidth) || 0;
              var bcl = lum(cs.borderTopColor); // -1 if transparent
              if (bw < 1 || bcl < 30) { // no border, or too faint/dark to read
                el.style.setProperty('border', '1px solid rgba(255,255,255,0.12)', 'important');
              }
              el.dataset.bbFr = '1';
            }
          }
        }
      }
    }
  }

  function run() { try { normalize(); } catch (e) {} }

  if (document.readyState !== 'loading') run();
  else document.addEventListener('DOMContentLoaded', run);
  window.addEventListener('load', run);
  window.addEventListener('hashchange', function () { setTimeout(run, 120); });

  // Dynamic content — modals, JS-rendered cards. We observe childList only, so
  // our own inline-style writes (attribute changes) never re-trigger us: no loop.
  var timer;
  var mo = new MutationObserver(function () { clearTimeout(timer); timer = setTimeout(run, 140); });
  function observe() { if (document.body) mo.observe(document.body, { childList: true, subtree: true }); }
  if (document.body) observe(); else document.addEventListener('DOMContentLoaded', observe);
})();
