/**
 * Boost Boss — branded dialogs (replaces native alert/confirm/prompt)
 *
 *   bbAlert(message, opts?)   → Promise<void>
 *   bbConfirm(message, opts?) → Promise<boolean>
 *   bbPrompt(message, opts?)  → Promise<string|null>
 *
 * opts: { title, okText, cancelText, danger:true, placeholder, default }
 *
 * window.alert is transparently overridden (alert returns void, so existing
 * `alert('x')` calls become branded with no code changes). confirm/prompt are
 * synchronous natives that can't be shimmed to a promise, so those call sites
 * must be refactored to `bbConfirm(...).then(ok => ...)`.
 */
(function () {
  if (window.bbConfirm) return; // load once

  var _nativeAlert = window.alert ? window.alert.bind(window) : function () {};

  function injectStyles() {
    if (document.getElementById('bb-modal-styles')) return;
    var s = document.createElement('style');
    s.id = 'bb-modal-styles';
    s.textContent = [
      '.bbm-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;',
      'background:rgba(6,6,10,.62);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);',
      'opacity:0;transition:opacity .16s ease;font-family:var(--font-body,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);padding:20px}',
      '.bbm-backdrop.bbm-in{opacity:1}',
      '.bbm-card{width:100%;max-width:400px;background:linear-gradient(180deg,#1B1D22,#141619);',
      'border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.55);',
      'padding:24px 24px 20px;transform:translateY(8px) scale(.98);transition:transform .18s cubic-bezier(.2,.8,.2,1);color:#E7E9EA}',
      '.bbm-backdrop.bbm-in .bbm-card{transform:none}',
      '.bbm-icon{width:40px;height:40px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:14px;',
      'background:rgba(255,45,120,.12);border:1px solid rgba(255,45,120,.3)}',
      '.bbm-title{font-family:var(--font-display,inherit);font-size:17px;font-weight:700;color:#fff;margin:0 0 6px;letter-spacing:-.01em}',
      '.bbm-msg{font-size:14px;line-height:1.55;color:rgba(231,233,234,.72);margin:0 0 20px;white-space:pre-wrap;word-break:break-word}',
      '.bbm-input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.16);',
      'border-radius:10px;padding:11px 13px;color:#fff;font-size:14px;font-family:inherit;margin:-8px 0 20px}',
      '.bbm-input:focus{outline:none;border-color:rgba(0,255,224,.5)}',
      '.bbm-actions{display:flex;gap:10px;justify-content:flex-end}',
      '.bbm-btn{font-family:inherit;font-size:14px;font-weight:600;padding:10px 18px;border-radius:10px;border:1.5px solid transparent;cursor:pointer;transition:transform .1s,background .15s,border-color .15s}',
      '.bbm-btn:active{transform:scale(.97)}',
      '.bbm-btn-ghost{background:rgba(255,255,255,.06);color:#E7E9EA;border-color:rgba(255,255,255,.16)}',
      '.bbm-btn-ghost:hover{background:rgba(255,255,255,.11)}',
      '.bbm-btn-primary{background:#FF2D78;color:#fff;border-color:#FF2D78}',
      '.bbm-btn-primary:hover{background:#E01E65;border-color:#E01E65}',
      '.bbm-btn-danger{background:#F4212E;color:#fff;border-color:#F4212E}',
      '.bbm-btn-danger:hover{background:#D01824;border-color:#D01824}',
      '@media(prefers-reduced-motion:reduce){.bbm-backdrop,.bbm-card{transition:none}}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // kind: 'alert' | 'confirm' | 'prompt'
  function dialog(kind, message, opts) {
    opts = opts || {};
    injectStyles();
    return new Promise(function (resolve) {
      var danger = !!opts.danger;
      var isPrompt = kind === 'prompt';
      var isConfirm = kind === 'confirm';
      var title = opts.title || (isConfirm ? 'Please confirm' : (isPrompt ? 'Enter a value' : 'Notice'));
      var okText = opts.okText || (isConfirm ? 'Confirm' : 'OK');
      var cancelText = opts.cancelText || 'Cancel';
      var icon = opts.icon || (danger ? '⚠️' : (isConfirm ? '❔' : (isPrompt ? '✏️' : '🚀')));

      var back = document.createElement('div');
      back.className = 'bbm-backdrop';
      back.setAttribute('role', 'dialog');
      back.setAttribute('aria-modal', 'true');
      back.innerHTML =
        '<div class="bbm-card" role="document">' +
          '<div class="bbm-icon"' + (danger ? ' style="background:rgba(244,33,46,.12);border-color:rgba(244,33,46,.35)"' : '') + '>' + icon + '</div>' +
          '<h3 class="bbm-title">' + esc(title) + '</h3>' +
          '<p class="bbm-msg">' + esc(message) + '</p>' +
          (isPrompt ? '<input class="bbm-input" type="text" placeholder="' + esc(opts.placeholder || '') + '" value="' + esc(opts.default || '') + '">' : '') +
          '<div class="bbm-actions">' +
            ((isConfirm || isPrompt) ? '<button class="bbm-btn bbm-btn-ghost" data-bbm="cancel">' + esc(cancelText) + '</button>' : '') +
            '<button class="bbm-btn ' + (danger ? 'bbm-btn-danger' : 'bbm-btn-primary') + '" data-bbm="ok">' + esc(okText) + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(back);
      var input = back.querySelector('.bbm-input');
      var okBtn = back.querySelector('[data-bbm="ok"]');
      requestAnimationFrame(function () { back.classList.add('bbm-in'); });
      (input || okBtn).focus();

      function cleanup() {
        document.removeEventListener('keydown', onKey, true);
        back.classList.remove('bbm-in');
        setTimeout(function () { if (back.parentNode) back.parentNode.removeChild(back); }, 180);
      }
      function done(val) { cleanup(); resolve(val); }
      function onCancel() { done(isConfirm ? false : (isPrompt ? null : undefined)); }
      function onOk() { done(isConfirm ? true : (isPrompt ? (input ? input.value : '') : undefined)); }

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        else if (e.key === 'Enter' && (!input || document.activeElement === input || document.activeElement === okBtn)) { e.preventDefault(); onOk(); }
      }
      document.addEventListener('keydown', onKey, true);
      back.addEventListener('click', function (e) { if (e.target === back) onCancel(); });
      back.querySelector('[data-bbm="ok"]').addEventListener('click', onOk);
      var c = back.querySelector('[data-bbm="cancel"]');
      if (c) c.addEventListener('click', onCancel);
    });
  }

  window.bbAlert = function (message, opts) { return dialog('alert', message, opts); };
  window.bbConfirm = function (message, opts) { return dialog('confirm', message, opts); };
  window.bbPrompt = function (message, opts) { return dialog('prompt', message, opts); };

  // Transparent override: alert() returns void, so every existing alert('x')
  // now shows the branded dialog with no call-site changes.
  window.alert = function (message) { dialog('alert', message); };
  // Keep a handle to the native in case anything truly needs it.
  window.bbNativeAlert = _nativeAlert;
})();
