/**
 * Boost Boss — Branded HTML email templates
 *
 * Single base layout that mirrors the Supabase auth-email templates
 * (rocket logo, pink button, soft card). All transactional emails sent
 * by the boostboss.ai backend route through `renderEmail()` here, so
 * one design change updates every email the app sends.
 *
 * The logo at https://boostboss.ai/email-logo.png must exist — added
 * 2026-06-11 (rocket b-mark, 480×480 PNG).
 *
 * Convention:
 *   - 56×56 logo at top-left next to "Boost Boss" wordmark
 *   - Heading (Space Grotesk, 26px, dark ink)
 *   - Body paragraphs (15.5px, soft ink, 1.65 line-height)
 *   - Optional highlight panel (pink / amber / green / red themed)
 *   - Optional CTA button (pink, 14×36 padding, bold)
 *   - Footer with privacy/terms links + support contact
 */

const BRAND = {
  logoUrl:   "https://boostboss.ai/email-logo.png",
  brandName: "Boost Boss",
  primary:   "#FF2D78",
  primaryDk: "#E01E65",
  ink:       "#1A1A2E",
  inkSoft:   "#4B4B5E",
  muted:     "#6B7280",
  bg:        "#FAFAF7",
  surface:   "#FFFFFF",
  line:      "#EAEAEF",
};

/**
 * Render a full HTML email from the standard layout.
 *
 * @param {object} opts
 * @param {string} opts.title         — used as the <title> + h1 of the email
 * @param {string} [opts.preheader]   — invisible preview text shown in inbox
 * @param {string} opts.bodyHtml      — main content HTML (paragraphs, highlight
 *                                       panels, etc) — gets dropped between
 *                                       the heading and the optional CTA
 * @param {object} [opts.cta]         — { label, url } — renders the pink
 *                                       call-to-action button. Omit for
 *                                       notification-only emails.
 * @param {string} [opts.footerNote]  — small grey text above the standard
 *                                       footer (e.g. "didn't request this?
 *                                       contact support@")
 * @returns {string} full HTML document
 */
function renderEmail(opts) {
  const {
    title,
    preheader = "",
    bodyHtml = "",
    cta = null,
    footerNote = "",
  } = opts;

  const preheaderHtml = preheader
    ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>`
    : "";

  const ctaHtml = cta
    ? `<div class="btn-wrap">
         <a href="${cta.url}" class="btn">${escapeHtml(cta.label)}</a>
       </div>`
    : "";

  const footerNoteHtml = footerNote
    ? `<p style="font-size:13px;color:${BRAND.muted};line-height:1.6;margin:0 0 14px;text-align:center;">${footerNote}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background: ${BRAND.bg}; color: ${BRAND.ink}; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 560px; margin: 40px auto; padding: 0 24px; }
  .card { background: ${BRAND.surface}; border: 1px solid ${BRAND.line}; border-radius: 16px; padding: 44px 40px; box-shadow: 0 4px 24px rgba(0,0,0,0.04); }
  /* Logo row uses a 2-cell table for vertical centering because Gmail
     and Outlook silently strip display:flex. Inline styles on the td
     are the actual carriers; these class-based rules are belt-and-
     suspenders for clients that DO honor CSS classes. */
  .logo-row { margin-bottom: 28px; border-collapse: collapse; }
  .logo-cell { vertical-align: middle; padding: 0; }
  .logo-cell.icon { padding-right: 14px; }
  .logo-img { width: 56px; height: 56px; display: block; }
  .brand { font-family: 'Space Grotesk', -apple-system, sans-serif; font-size: 22px; font-weight: 700; letter-spacing: -0.5px; color: ${BRAND.ink}; line-height: 1; }
  h1 { font-family: 'Space Grotesk', -apple-system, sans-serif; font-size: 26px; font-weight: 700; line-height: 1.25; margin: 0 0 16px; color: ${BRAND.ink}; letter-spacing: -0.3px; }
  p { font-size: 15.5px; line-height: 1.65; color: ${BRAND.inkSoft}; margin: 0 0 16px; }
  .btn-wrap { margin: 30px 0 22px; text-align: center; }
  .btn { display: inline-block; background: ${BRAND.primary}; color: #FFFFFF !important; font-weight: 700; font-size: 16px; padding: 14px 36px; border-radius: 10px; text-decoration: none; }
  .btn:hover { background: ${BRAND.primaryDk}; }
  .panel { border-radius: 10px; padding: 16px 18px; margin: 22px 0; font-size: 14px; line-height: 1.55; }
  .panel.success { background: #ECFDF5; border: 1px solid #A7F3D0; color: #065F46; }
  .panel.success strong { color: #064E3B; }
  .panel.info { background: #FFF5F8; border: 1px solid #FFD0E0; color: ${BRAND.inkSoft}; }
  .panel.info strong { color: ${BRAND.ink}; }
  .panel.warn { background: #FFF7E6; border: 1px solid #FCD34D; color: #B97309; }
  .panel.warn strong { color: #92400E; }
  .panel.danger { background: #FEF2F2; border: 1px solid #FECACA; color: #991B1B; }
  .panel.danger strong { color: #7F1D1D; }
  .stats-table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 14.5px; }
  .stats-table td { padding: 10px 14px; border-bottom: 1px solid ${BRAND.line}; color: ${BRAND.inkSoft}; }
  .stats-table td:last-child { text-align: right; font-weight: 600; color: ${BRAND.ink}; }
  .stats-table tr:last-child td { border-bottom: 0; }
  .divider { height: 1px; background: ${BRAND.line}; margin: 32px 0 22px; border: 0; }
  .foot { font-size: 13px; color: ${BRAND.muted}; text-align: center; line-height: 1.6; }
  .foot a { color: ${BRAND.primary}; text-decoration: none; }
</style>
</head>
<body>
  ${preheaderHtml}
  <div class="wrap">
    <div class="card">
      <table class="logo-row" role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;border-collapse:collapse;">
        <tr>
          <td class="logo-cell icon" valign="middle" style="vertical-align:middle;padding:0 14px 0 0;line-height:0;">
            <img class="logo-img" src="${BRAND.logoUrl}" alt="${BRAND.brandName}" width="56" height="56" style="display:block;width:56px;height:56px;">
          </td>
          <td class="logo-cell" valign="middle" style="vertical-align:middle;padding:0;">
            <span class="brand" style="font-family:'Space Grotesk',-apple-system,sans-serif;font-size:22px;font-weight:700;letter-spacing:-0.5px;color:${BRAND.ink};line-height:1;">${BRAND.brandName}</span>
          </td>
        </tr>
      </table>

      <h1>${escapeHtml(title)}</h1>
      ${bodyHtml}
      ${ctaHtml}

      <hr class="divider">

      ${footerNoteHtml}
      <p class="foot">
        Boost Boss · <a href="https://boostboss.ai/privacy">Privacy</a> · <a href="https://boostboss.ai/terms">Terms</a><br>
        Questions? <a href="mailto:support@boostboss.ai">support@boostboss.ai</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ─── Per-email-type renderers ─────────────────────────────────────────
// Each function returns { subject, html } ready to pass to send().

function welcomeEmail({ role, firstName, dashboardUrl }) {
  const isPublisher = role === "developer";
  const product   = isPublisher ? "Lumi SDK" : "SuperBoost Ads";
  const nextSteps = isPublisher
    ? `<p><strong>Next steps:</strong></p>
       <ul style="font-size:15px; line-height:1.7; color:${BRAND.inkSoft}; padding-left:22px; margin:0 0 16px;">
         <li>Pick your installation door (MCP, JS Snippet, NPM SDK, or REST API)</li>
         <li>Drop the snippet into your AI app</li>
         <li>Watch revenue accrue on your dashboard</li>
       </ul>`
    : `<p><strong>Next steps:</strong></p>
       <ul style="font-size:15px; line-height:1.7; color:${BRAND.inkSoft}; padding-left:22px; margin:0 0 16px;">
         <li>Fund your account via PayPal</li>
         <li>Launch your first campaign in under 60 seconds</li>
         <li>Reach AI-native users via SuperBoost Ads — see real intent, not cookies</li>
       </ul>`;

  return {
    subject: `Welcome to ${product} 🚀`,
    html: renderEmail({
      title: `Welcome to ${product}`,
      preheader: `Your account is live. Here's how to get started.`,
      bodyHtml: `
        <p>Hi${firstName ? " " + escapeHtml(firstName) : ""}, welcome to Boost Boss — the AI-native ad network.</p>
        <p>${isPublisher
          ? "Monetize your AI app or MCP server with ads that match user intent — 2-4× the eCPM of generic ad networks because our advertisers see real declared intent, not cookies."
          : "Your users tell their AI exactly what they want. We surface relevant ads against that declared intent. Pay only for engaged impressions."}</p>
        ${nextSteps}
      `,
      cta: { label: isPublisher ? "Go to publisher dashboard" : "Launch your first campaign", url: dashboardUrl },
      footerNote: `Need help getting started? Just reply to this email — we read everything.`,
    }),
  };
}

function depositSuccessEmail({ amountUsd, balanceAfterUsd, companyName, dashboardUrl }) {
  return {
    subject: `Your deposit of $${formatUsd(amountUsd)} was successful`,
    html: renderEmail({
      title: "Deposit received",
      preheader: `$${formatUsd(amountUsd)} added to your Boost Boss balance. New balance: $${formatUsd(balanceAfterUsd)}.`,
      bodyHtml: `
        <p>${companyName ? "Hi " + escapeHtml(companyName) + " — " : ""}your deposit landed successfully. You're ready to spend.</p>
        <table class="stats-table" role="presentation">
          <tr><td>Amount deposited</td><td>$${formatUsd(amountUsd)}</td></tr>
          <tr><td>New account balance</td><td style="color:${BRAND.primary};">$${formatUsd(balanceAfterUsd)}</td></tr>
          <tr><td>Payment method</td><td>PayPal</td></tr>
        </table>
        <p>Your balance is live now. Launch a campaign whenever you're ready.</p>
      `,
      cta: { label: "Go to dashboard", url: dashboardUrl },
      footerNote: `PayPal also sent you a separate receipt. This email is from Boost Boss confirming the funds landed on your campaign balance.`,
    }),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────
function formatUsd(n) {
  const num = Number(n) || 0;
  return num.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = {
  renderEmail,
  welcomeEmail,
  depositSuccessEmail,
  BRAND,
};
