// Boost Boss i18n — URL-based language routing (/en, /zh, /ja, /ko, /vi)
// Reads lang from window.location.pathname's first segment.
// When user picks a language, navigates to /<lang> so the URL reflects state.
(function () {
  'use strict';

  var DICT_VERSION = 'bb-20260421';
  var SUPPORTED   = ['en', 'zh', 'ja', 'ko', 'vi'];
  var DEFAULT     = 'en';

  // Parse first path segment, e.g. "/en/foo" -> "en"
  function pathLang() {
    var seg = (window.location.pathname || '/').split('/')[1] || '';
    return SUPPORTED.indexOf(seg) !== -1 ? seg : null;
  }

  function getLang() {
    return pathLang() || DEFAULT;
  }

  function getText(dict, keyPath) {
    var parts = keyPath.split('.');
    var cur = dict;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function loadDict(lang) {
    return fetch('/i18n/' + lang + '.json?v=' + DICT_VERSION, { cache: 'default' })
      .then(function (r) { if (!r.ok) throw new Error(lang + ' missing'); return r.json(); });
  }

  function apply(dict) {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute('data-i18n');
      var val = getText(dict, key);
      if (val === undefined) continue;
      if (el.hasAttribute('data-i18n-html')) {
        el.innerHTML = val;
      } else {
        el.textContent = val;
      }
    }
    var attrNodes = document.querySelectorAll('[data-i18n-attr]');
    for (var j = 0; j < attrNodes.length; j++) {
      var n = attrNodes[j];
      var pairs = n.getAttribute('data-i18n-attr').split(',');
      for (var k = 0; k < pairs.length; k++) {
        var bits = pairs[k].trim().split(':');
        if (bits.length !== 2) continue;
        var v = getText(dict, bits[1].trim());
        if (v !== undefined) n.setAttribute(bits[0].trim(), v);
      }
    }

    // Dropdown active state + button label
    var active = getLang();
    var menuLinks = document.querySelectorAll('.nav-lang-menu a[data-lang]');
    for (var m = 0; m < menuLinks.length; m++) {
      var lang = menuLinks[m].getAttribute('data-lang');
      menuLinks[m].classList.toggle('active', lang === active);
      // Point each menu link at /<lang> so right-click/"open in new tab" works too
      menuLinks[m].setAttribute('href', '/' + lang);
    }
    var btnLabel = document.querySelector('.nav-lang span');
    if (btnLabel) btnLabel.textContent = active.toUpperCase();
    document.documentElement.lang = active;
  }

  // Public API — navigate to /<lang>
  window.setBBLang = function (lang) {
    if (SUPPORTED.indexOf(lang) === -1) return;
    if (lang === getLang()) return;
    window.location.href = '/' + lang;
  };

  function init() {
    var lang = getLang();
    loadDict(lang).then(apply).catch(function (err) {
      console.error('[i18n init]', err);
    });

    // Intercept dropdown clicks so we route cleanly (history push + reload)
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('.nav-lang-menu a[data-lang]');
      if (!a) return;
      e.preventDefault();
      window.setBBLang(a.getAttribute('data-lang'));
      var wrap = document.getElementById('navLangWrap');
      if (wrap) wrap.classList.remove('open');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
