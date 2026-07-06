/**
 * Boost Boss — Transactional email sender
 *
 * Wraps the Resend SDK with:
 *   - Graceful "no-op in dev / demo" if RESEND_API_KEY is missing
 *     (so local tests don't fail and so api/auth.js demo mode doesn't
 *     send real emails)
 *   - Per-email-type sender address (billing@, hello@, etc)
 *     so users can mentally bucket emails by sender
 *   - Reply-To headers routing replies to support@boostboss.ai (since the
 *     individual sender aliases like noreply@ shouldn't accept inbound mail)
 *   - Structured error logging (Vercel logs surface these in the dashboard)
 *
 * Each email type gets its own helper function (sendWelcome, sendDepositSuccess)
 * so callers don't have to know about subject lines, templates, or sender
 * aliases.
 *
 * Resend account: admin@boostboss.ai
 * Resend domain: boostboss.ai (verified 2026-06-11)
 * API key env var: RESEND_API_KEY (set in Vercel project env)
 */

const {
  welcomeEmail,
  depositSuccessEmail,
} = require("./templates");

const PUBLIC_BASE =
  process.env.PUBLIC_BASE ||
  process.env.PUBLIC_BASE_URL ||
  "https://boostboss.ai";

// Per-email-type sender aliases. Each is a real Workspace alias on
// admin@boostboss.ai → see launch-kit/EMAIL-TEMPLATES.md "Workspace setup"
// notes. Resend allows any sender within the verified boostboss.ai domain.
const SENDERS = {
  welcome:        { name: "Boost Boss",          alias: "hello"    },
  billing:        { name: "Boost Boss Billing",  alias: "billing"  },
  alerts:         { name: "Boost Boss Alerts",   alias: "alerts"   },
  support:        { name: "Boost Boss Support",  alias: "support"  },
};

const REPLY_TO = "support@boostboss.ai";

// ── Lazy Resend client ──────────────────────────────────────────────
let _resend = null;
function getResend() {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  try {
    const { Resend } = require("resend");
    _resend = new Resend(key);
    return _resend;
  } catch (e) {
    console.warn("[Emails] resend SDK not installed —", e.message);
    return null;
  }
}

// ── Core send wrapper ──────────────────────────────────────────────
async function send({ kind, to, subject, html, replyTo = REPLY_TO }) {
  if (!to) {
    console.warn(`[Emails] ${kind} — refusing to send: no recipient`);
    return { sent: false, reason: "no_recipient" };
  }
  const sender = SENDERS[kind] || SENDERS.welcome;
  const from = `${sender.name} <${sender.alias}@boostboss.ai>`;

  const resend = getResend();
  if (!resend) {
    // No API key → no-op. Log the intent so we can see in dev that the
    // email would have been sent. Don't throw — caller code (billing.js,
    // auth.js) shouldn't fail just because email isn't configured.
    console.log(`[Emails] (no-RESEND_API_KEY) would send ${kind} to ${to}: "${subject}"`);
    return { sent: false, reason: "no_api_key" };
  }

  try {
    const result = await resend.emails.send({
      from,
      to,
      subject,
      html,
      replyTo,
    });
    if (result.error) {
      console.error(`[Emails] ${kind} → ${to} failed:`, result.error.message);
      return { sent: false, reason: "resend_error", error: result.error };
    }
    console.log(`[Emails] ${kind} → ${to} ok (id=${result.data && result.data.id})`);
    return { sent: true, id: result.data && result.data.id };
  } catch (e) {
    console.error(`[Emails] ${kind} → ${to} threw:`, e.message);
    return { sent: false, reason: "exception", error: e };
  }
}

// ── Per-email-type helpers (one per use case) ─────────────────────────
//
// These are what the rest of the codebase calls. They build subject + html
// from `templates.js` and call `send()` with the right sender alias.
//
// All are best-effort: they never throw. If sending fails, the action that
// triggered the email (e.g. crediting a deposit) still completes — email
// is observability + UX polish, not a critical path.

async function sendWelcome({ to, role, firstName }) {
  const dashboardUrl = role === "developer"
    ? `${PUBLIC_BASE}/publish/dashboard`
    : `${PUBLIC_BASE}/ads/dashboard`;
  const { subject, html } = welcomeEmail({ role, firstName, dashboardUrl });
  return send({ kind: "welcome", to, subject, html });
}

async function sendDepositSuccess({ to, amountUsd, balanceAfterUsd, companyName }) {
  const dashboardUrl = `${PUBLIC_BASE}/ads/dashboard`;
  const { subject, html } = depositSuccessEmail({
    amountUsd, balanceAfterUsd, companyName, dashboardUrl,
  });
  return send({ kind: "billing", to, subject, html });
}

module.exports = {
  sendWelcome,
  sendDepositSuccess,
  // Lower-level API in case future code needs custom emails:
  send,
  SENDERS,
};
