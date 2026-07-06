/**
 * Boost Boss Assistant — drop-in floating Q&A widget.
 *
 * Usage:
 *   <script src="/assist.js" data-surface="advertiser"></script>
 *
 * Attributes on the <script> tag:
 *   data-surface  — "advertiser" | "publisher" | "marketing"  (default: advertiser)
 *   data-api-base — optional API base URL (default: same origin)
 *   data-lang     — optional override; otherwise read from <html lang> or 'en'
 *
 * What this renders:
 *   - A floating pink pulse bubble at bottom-right (28px gutters)
 *   - On click: a 360×500 chat panel with starter chips, message stream,
 *     textarea + send. Closes on outside-click / Esc.
 *   - All styles scoped under .bba-* class names; no Tailwind, no deps.
 *
 * v1 = strict Q&A. No actions, no session persistence, no history.
 */
(function () {
  if (window.__bba_loaded__) return;          // idempotent — never double-init
  window.__bba_loaded__ = true;

  const script  = document.currentScript;
  const SURFACE = (script && script.getAttribute('data-surface')) || 'advertiser';
  const API     = (script && script.getAttribute('data-api-base')) || '';
  const langAttr = script && script.getAttribute('data-lang');
  const getLang = () =>
    langAttr ||
    (document.documentElement && document.documentElement.getAttribute('lang')) ||
    (window.DASH_LANG || 'en');

  // ── Starter chips per surface — quick way to seed productive Qs ───
  const STARTERS = {
    advertiser: [
      'How do I create my first campaign?',
      'What does the Benna chip on a campaign mean?',
      'How do I install the conversion pixel?',
      'What is Auction Insights showing me?',
    ],
    publisher: [
      'How do I tag placements?',
      'How do I spend my earned credits?',
      'How is my RPM calculated?',
      'What does the intent score mean?',
    ],
    marketing: [
      'How is Boost Boss different from AppLovin?',
      'How do publishers integrate?',
      'How much does it cost?',
      'What\'s Benna optimizing?',
    ],
  };

  // ── Inject scoped styles once ─────────────────────────────────────
  const css = `
.bba-fab {
    position: fixed; right: 24px; bottom: 24px; z-index: 99998;
    width: 56px; height: 56px; border-radius: 50%;
    background: linear-gradient(135deg, #FF2D78, #FF85B1);
    color: #fff; border: none; cursor: pointer;
    box-shadow: 0 8px 24px rgba(255, 45, 120, 0.35);
    display: flex; align-items: center; justify-content: center;
    transition: transform 0.18s ease, box-shadow 0.18s ease;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
}
.bba-fab:hover { transform: translateY(-2px); box-shadow: 0 12px 28px rgba(255, 45, 120, 0.45); }
.bba-fab svg { width: 26px; height: 26px; }
.bba-fab.is-open { transform: scale(0.92); }
.bba-fab-badge {
    position: absolute; top: -2px; right: -2px;
    width: 14px; height: 14px; border-radius: 50%;
    background: #FFD700; border: 2px solid #fff;
    opacity: 0; pointer-events: none; transition: opacity 0.2s ease;
}
.bba-fab-badge.is-visible { opacity: 1; }

.bba-panel {
    position: fixed; right: 24px; bottom: 92px; z-index: 99999;
    width: 360px; max-width: calc(100vw - 32px);
    height: 500px; max-height: calc(100vh - 120px);
    background: #fff; border-radius: 16px;
    box-shadow: 0 20px 60px rgba(15, 15, 26, 0.22);
    display: none; flex-direction: column; overflow: hidden;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 14px; color: #1A1A2E;
    transform: translateY(8px); opacity: 0;
    transition: transform 0.2s ease, opacity 0.2s ease;
}
.bba-panel.is-open { display: flex; transform: translateY(0); opacity: 1; }

.bba-head {
    padding: 14px 16px; border-bottom: 1px solid #F1F2F4;
    display: flex; align-items: center; gap: 10px;
}
.bba-head-icon {
    width: 28px; height: 28px; border-radius: 50%;
    background: linear-gradient(135deg, #FF2D78, #FF85B1);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 800; font-size: 12px; letter-spacing: -0.5px;
}
.bba-head-text { flex: 1; min-width: 0; }
.bba-head-title { font-weight: 700; font-size: 14px; line-height: 1.2; }
.bba-head-sub   { font-size: 11px; color: #6B7280; margin-top: 1px; }
.bba-head-close {
    background: transparent; border: none; cursor: pointer;
    width: 28px; height: 28px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    color: #6B7280; font-size: 16px;
}
.bba-head-close:hover { background: #F1F2F4; color: #1A1A2E; }

.bba-stream {
    flex: 1; min-height: 0; overflow-y: auto;
    padding: 14px 16px; background: #FAFAFA;
    display: flex; flex-direction: column; gap: 10px;
}
.bba-msg {
    max-width: 88%; padding: 9px 12px; border-radius: 12px;
    line-height: 1.45; font-size: 13px; word-wrap: break-word;
    white-space: pre-wrap;
}
.bba-msg.user { align-self: flex-end; background: #1A1A2E; color: #fff; border-bottom-right-radius: 4px; }
.bba-msg.bot  { align-self: flex-start; background: #fff; border: 1px solid #E5E7EB; border-bottom-left-radius: 4px; }
.bba-msg.bot.is-thinking { color: #9CA3AF; font-style: italic; }
.bba-msg.bot.is-error    { border-color: #FECACA; background: #FEF2F2; color: #991B1B; }

.bba-starters {
    display: flex; flex-direction: column; gap: 6px;
    margin-top: 4px;
}
.bba-starter {
    text-align: left; background: #fff; border: 1px solid #E5E7EB;
    border-radius: 10px; padding: 9px 12px; cursor: pointer;
    font-size: 12.5px; color: #374151; font-family: inherit;
    transition: border-color 0.12s ease, color 0.12s ease;
}
.bba-starter:hover { border-color: #FF2D78; color: #FF2D78; }

.bba-foot {
    padding: 10px 12px; border-top: 1px solid #F1F2F4;
    background: #fff;
}
.bba-input-row {
    display: flex; gap: 8px; align-items: flex-end;
}
.bba-input {
    flex: 1; min-height: 36px; max-height: 100px;
    padding: 8px 10px; border: 1px solid #E5E7EB; border-radius: 10px;
    font: 13px/1.4 inherit; resize: none; outline: none;
    background: #FAFAFA; color: #1A1A2E;
}
.bba-input:focus { border-color: #FF2D78; background: #fff; }
.bba-send {
    width: 36px; height: 36px; border-radius: 50%;
    background: linear-gradient(135deg, #FF2D78, #FF85B1);
    color: #fff; border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
}
.bba-send:disabled { opacity: 0.4; cursor: not-allowed; }
.bba-send svg { width: 16px; height: 16px; }

.bba-meta {
    margin-top: 6px; text-align: center;
    font-size: 10px; color: #9CA3AF; line-height: 1.4;
}
.bba-meta a { color: #6B7280; text-decoration: underline; }
`;
  const styleEl = document.createElement('style');
  styleEl.setAttribute('data-bba', '1');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── DOM ───────────────────────────────────────────────────────────
  const fab = document.createElement('button');
  fab.className = 'bba-fab';
  fab.setAttribute('aria-label', 'Open Boost Boss assistant');
  fab.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
    '</svg>' +
    '<span class="bba-fab-badge"></span>';

  const panel = document.createElement('div');
  panel.className = 'bba-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Boost Boss assistant');
  panel.innerHTML = `
    <div class="bba-head">
      <div class="bba-head-icon">BB</div>
      <div class="bba-head-text">
        <div class="bba-head-title">Boost Boss assistant</div>
        <div class="bba-head-sub">Q&amp;A · powered by Benna</div>
      </div>
      <button class="bba-head-close" aria-label="Close">✕</button>
    </div>
    <div class="bba-stream" id="bbaStream"></div>
    <div class="bba-foot">
      <div class="bba-input-row">
        <textarea class="bba-input" id="bbaInput" rows="1"
          placeholder="Ask anything about the dashboard…"></textarea>
        <button class="bba-send" id="bbaSend" aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
      <div class="bba-meta">
        Not a replacement for a human — for billing, account, or anything tricky,
        email <a href="mailto:support@boostboss.ai">support@boostboss.ai</a>.
      </div>
    </div>
  `;

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  const stream    = panel.querySelector('#bbaStream');
  const input     = panel.querySelector('#bbaInput');
  const sendBtn   = panel.querySelector('#bbaSend');
  const closeBtn  = panel.querySelector('.bba-head-close');

  // ── State ─────────────────────────────────────────────────────────
  let isOpen = false;
  let inFlight = false;
  let firstMessageSent = false;

  function openPanel() {
    if (isOpen) return;
    isOpen = true;
    panel.classList.add('is-open');
    fab.classList.add('is-open');
    fab.querySelector('.bba-fab-badge').classList.remove('is-visible');
    if (!firstMessageSent) renderGreeting();
    setTimeout(() => input.focus(), 80);
  }
  function closePanel() {
    isOpen = false;
    panel.classList.remove('is-open');
    fab.classList.remove('is-open');
  }
  function toggle() { isOpen ? closePanel() : openPanel(); }

  fab.addEventListener('click', toggle);
  closeBtn.addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) closePanel(); });
  // Outside click → close. Don't close when clicking the fab itself.
  document.addEventListener('click', (e) => {
    if (!isOpen) return;
    if (panel.contains(e.target) || fab.contains(e.target)) return;
    closePanel();
  });

  // ── Greeting + starter chips, shown on first open ─────────────────
  function renderGreeting() {
    const greetEnglish = SURFACE === 'publisher'
      ? "Hi — I'm scoped to help you with the publisher dashboard. Pick a starter or type your question."
      : SURFACE === 'marketing'
      ? "Hi — ask me anything about Boost Boss. Pick a starter or type your question."
      : "Hi — I'm scoped to help you run campaigns. Pick a starter or type your question.";
    const greet = document.createElement('div');
    greet.className = 'bba-msg bot';
    greet.textContent = greetEnglish;
    stream.appendChild(greet);

    const starters = STARTERS[SURFACE] || STARTERS.advertiser;
    const wrap = document.createElement('div');
    wrap.className = 'bba-starters';
    starters.forEach(q => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bba-starter';
      b.textContent = q;
      b.addEventListener('click', () => {
        wrap.remove();
        send(q);
      });
      wrap.appendChild(b);
    });
    stream.appendChild(wrap);
  }

  // ── Send a question, render the answer ────────────────────────────
  async function send(text) {
    const q = (text || input.value || '').trim();
    if (!q || inFlight) return;
    inFlight = true;
    firstMessageSent = true;
    input.value = '';
    autosize();

    const userMsg = document.createElement('div');
    userMsg.className = 'bba-msg user';
    userMsg.textContent = q;
    stream.appendChild(userMsg);

    const thinking = document.createElement('div');
    thinking.className = 'bba-msg bot is-thinking';
    thinking.textContent = 'Thinking…';
    stream.appendChild(thinking);
    stream.scrollTop = stream.scrollHeight;
    sendBtn.disabled = true;

    try {
      const body = {
        question: q,
        surface:  SURFACE,
        lang:     getLang(),
        route:    (typeof location !== 'undefined') ? (location.hash || location.pathname) : '',
      };
      const r = await fetch((API || '') + '/api/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      thinking.classList.remove('is-thinking');
      if (!r.ok) {
        thinking.classList.add('is-error');
        thinking.textContent = data.answer || 'Sorry — request failed. Try again, or email support@boostboss.ai.';
      } else {
        thinking.textContent = data.answer || '';
      }
    } catch (e) {
      thinking.classList.remove('is-thinking');
      thinking.classList.add('is-error');
      thinking.textContent = "Couldn't reach the assistant. Check your connection or email support@boostboss.ai.";
    } finally {
      inFlight = false;
      sendBtn.disabled = false;
      stream.scrollTop = stream.scrollHeight;
      input.focus();
    }
  }

  // Auto-resize the textarea up to 100px.
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 100) + 'px';
  }

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', () => send());

  // After 25s of idle on a page, show a subtle gold dot on the fab to
  // hint the assistant is here. Once.
  setTimeout(() => {
    if (!isOpen) fab.querySelector('.bba-fab-badge').classList.add('is-visible');
  }, 25000);
})();
