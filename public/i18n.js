// Boost Boss i18n — simple client-side translator
// Reads lang from localStorage, loads /i18n/<lang>.json, walks the DOM
// replacing text of [data-i18n="key.path"] elements. Exposes window.setBBLang.
(function () {
  'use strict';

  var DICT_VERSION = 'bb-20260421';
  var SUPPORTED   = ['en', 'zh', 'ja', 'ko', 'vi'];
  var DEFAULT     = 'en';
  var STORAGE_KEY = 'bb_lang';

  function getLang() {
    var stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) {}
    if (SUPPORTED.indexOf(stored) !== -1) return stored;
    return DEFAULT;
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
    // Swap text content
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
    // Swap attribute (e.g. placeholder / aria-label)
    var attrNodes = document.querySelectorAll('[data-i18n-attr]');
    for (var j = 0; j < attrNodes.length; j++) {
      var n = attrNodes[j];
      // data-i18n-attr="placeholder:hero.input_placeholder,aria-label:hero.cta"
      var pairs = n.getAttribute('data-i18n-attr').split(',');
      for (var k = 0; k < pairs.length; k++) {
        var bits = pairs[k].trim().split(':');
        if (bits.length !== 2) continue;
        var v = getText(dict, bits[1].trim());
        if (v !== undefined) n.setAttribute(bits[0].trim(), v);
      }
    }

    // Reflect active lang in dropdown + button label
    var active = getLang();
    var menuLinks = document.querySelectorAll('.nav-lang-menu a[data-lang]');
    for (var m = 0; m < menuLinks.length; m++) {
      menuLinks[m].classList.toggle('active', menuLinks[m].getAttribute('data-lang') === active);
    }
    var btnLabel = document.querySelector('.nav-lang span');
    if (btnLabel) btnLabel.textContent = active.toUpperCase();
    document.documentElement.lang = active;
  }

  window.setBBLang = function (lang) {
    if (SUPPORTED.indexOf(lang) === -1) return;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
    loadDict(lang).then(apply).catch(function (err) {
      console.error('[i18n]', err);
    });
  };

  // Init on DOM ready
  function init() {
    var lang = getLang();
    loadDict(lang).then(apply).catch(function (err) {
      console.error('[i18n init]', err);
    });

    // Wire dropdown item clicks
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
