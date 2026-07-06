/**
 * Boost Boss — PayPal pay-in client wrapper
 *
 * This is the demand-side payment rail (advertisers deposit ad credit).
 * It mirrors the shape of the Stripe lazy-loader in api/billing.js: if
 * env vars are missing, every function returns a deterministic demo
 * response so the test suite and DEMO mode never need real PayPal
 * credentials.
 *
 * Phase 2 scope (PayPal Orders v2 API):
 *   • OAuth client-credentials token (with in-process cache)
 *   • createOrder        — returns approval URL + order id
 *   • captureOrder       — finalizes payment, returns capture detail
 *   • refundCapture      — refunds a previously captured payment
 *   • getOrder           — fetch order state (for reconciliation)
 *   • verifyWebhook      — calls PayPal's verify-webhook-signature endpoint
 *
 * Why a custom wrapper instead of the @paypal/checkout-server-sdk package?
 *   • That SDK is in maintenance-only mode (PayPal recommends raw REST).
 *   • Lumi SDK + the rest of api/_lib avoid heavy deps; a plain fetch
 *     wrapper keeps cold-start latency and bundle size predictable.
 *   • Means the integration ships without an npm install in the test path.
 *
 * Environment variables read:
 *   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV ("sandbox"|"live"),
 *   PAYPAL_WEBHOOK_ID
 *
 * If PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is missing → DEMO mode.
 */

"use strict";

const HOSTS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live:    "https://api-m.paypal.com",
};

function getEnv() {
  const env = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();
  return env === "live" ? "live" : "sandbox";
}

function getBaseUrl() {
  return HOSTS[getEnv()];
}

function hasCreds() {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

// ── In-process OAuth token cache ─────────────────────────────────────
// PayPal access tokens are valid ~9 hours. We cache per-process and
// refresh 60 s before expiry. The cache key includes the env so a
// sandbox→live env flip in CI doesn't reuse a stale token.
let _tokenCache = { token: null, expiresAt: 0, env: null };

async function getAccessToken() {
  if (!hasCreds()) return null;
  const now = Date.now();
  if (_tokenCache.token && _tokenCache.expiresAt > now + 60_000 && _tokenCache.env === getEnv()) {
    return _tokenCache.token;
  }

  const basic = Buffer
    .from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`)
    .toString("base64");

  const res = await fetch(`${getBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type":  "application/x-www-form-urlencoded",
      "Accept":        "application/json",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`paypal_oauth_failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  _tokenCache = {
    token:     data.access_token,
    expiresAt: now + ((Number(data.expires_in) || 0) * 1000),
    env:       getEnv(),
  };
  return _tokenCache.token;
}

function _resetTokenCache() {
  _tokenCache = { token: null, expiresAt: 0, env: null };
}

// ── REST helper ──────────────────────────────────────────────────────
async function _paypalFetch(path, { method = "GET", body = null, requestId = null } = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error("paypal_not_configured");

  const headers = {
    "Authorization":  `Bearer ${token}`,
    "Content-Type":   "application/json",
    "Accept":         "application/json",
  };
  // PayPal Orders v2 strongly recommends PayPal-Request-Id for idempotency
  // on POSTs. Reuse the same id on retries and PayPal returns the original
  // response rather than creating a duplicate order.
  if (requestId) headers["PayPal-Request-Id"] = requestId;

  const res = await fetch(`${getBaseUrl()}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });

  // PayPal returns 204 for some refund endpoints; treat as success with empty body
  if (res.status === 204) return { ok: true, _status: 204 };

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { _raw: text }; }

  if (!res.ok) {
    const err = new Error(`paypal_http_${res.status}`);
    err.status = res.status;
    err.detail = json;
    throw err;
  }
  return json;
}

// ────────────────────────────────────────────────────────────────────
//                      DEMO-MODE DETERMINISTIC RESPONSES
// ────────────────────────────────────────────────────────────────────
// Every public function returns an object with the same shape as the
// real PayPal response so api/billing.js never has to branch on mode
// after dispatching. The `mode: "demo"` flag is the signal callers use
// to know they got a fake vs. real response.

function _demoOrderId() {
  return "ORDER_DEMO_" + Math.random().toString(36).slice(2, 10).toUpperCase();
}
function _demoCaptureId() {
  return "CAPTURE_DEMO_" + Math.random().toString(36).slice(2, 10).toUpperCase();
}
function _demoApprovalUrl(orderId) {
  return `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`;
}

// ────────────────────────────────────────────────────────────────────
//                                ORDERS
// ────────────────────────────────────────────────────────────────────

/**
 * Create a PayPal order for an advertiser deposit.
 *
 * @param {Object} opts
 * @param {string} opts.advertiserId   Boost Boss advertiser id (lands in custom_id)
 * @param {number} opts.amountUsd      USD amount to deposit (will be string-formatted)
 * @param {string} [opts.email]        Advertiser email (passed through for receipt)
 * @param {string} [opts.returnUrl]    Where to send the user after approval
 * @param {string} [opts.cancelUrl]    Where to send the user on cancel
 * @param {string} [opts.requestId]    PayPal-Request-Id for idempotency on retries
 *
 * @returns {Object} { mode, order_id, approval_url, raw }
 */
async function createOrder(opts) {
  const {
    advertiserId, amountUsd, email,
    returnUrl, cancelUrl, requestId,
  } = opts || {};

  if (!advertiserId) throw new Error("createOrder: advertiserId required");
  const amount = Number(amountUsd);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("createOrder: amountUsd must be a positive number");
  }
  const amountStr = amount.toFixed(2);

  if (!hasCreds()) {
    const orderId = _demoOrderId();
    return {
      mode:         "demo",
      order_id:     orderId,
      approval_url: _demoApprovalUrl(orderId),
      raw:          { id: orderId, status: "CREATED", _demo: true },
    };
  }

  const body = {
    intent: "CAPTURE",
    purchase_units: [{
      reference_id: "boost_boss_deposit",
      custom_id:    advertiserId,
      description:  `Boost Boss ad credit deposit ($${amountStr})`,
      amount: { currency_code: "USD", value: amountStr },
    }],
    application_context: {
      brand_name:           "Boost Boss",
      shipping_preference:  "NO_SHIPPING",
      user_action:          "PAY_NOW",
      return_url:           returnUrl || undefined,
      cancel_url:           cancelUrl || undefined,
    },
  };
  if (email) body.payer = { email_address: email };

  const order = await _paypalFetch("/v2/checkout/orders", {
    method:    "POST",
    body,
    requestId: requestId || undefined,
  });

  const approval = (order.links || []).find((l) => l.rel === "approve") || {};

  return {
    mode:         "paypal",
    order_id:     order.id,
    approval_url: approval.href || null,
    raw:          order,
  };
}

/**
 * Capture funds on an approved order. Called from the advertiser's
 * post-approval return URL with the order id PayPal sends back.
 *
 * Returns the canonical capture detail Boost Boss persists in
 * transactions.paypal_capture_id, including the amount actually
 * captured (which may differ from the order if the buyer edited it,
 * though in our flow it shouldn't).
 */
async function captureOrder(orderId, opts = {}) {
  if (!orderId) throw new Error("captureOrder: orderId required");

  if (!hasCreds()) {
    const captureId = _demoCaptureId();
    return {
      mode:        "demo",
      order_id:    orderId,
      capture_id:  captureId,
      status:      "COMPLETED",
      amount_usd:  Number(opts.expectedAmountUsd) || 0,
      payer_email: opts.payerEmail || null,
      raw: {
        id:     orderId,
        status: "COMPLETED",
        purchase_units: [{
          payments: { captures: [{ id: captureId, status: "COMPLETED", amount: {
            currency_code: "USD",
            value: (Number(opts.expectedAmountUsd) || 0).toFixed(2),
          } }] },
        }],
        _demo: true,
      },
    };
  }

  const captured = await _paypalFetch(`/v2/checkout/orders/${orderId}/capture`, {
    method:    "POST",
    body:      {},
    requestId: opts.requestId || undefined,
  });

  // Pull the first capture out of the deeply-nested response
  const pu     = (captured.purchase_units || [])[0] || {};
  const cap    = (((pu.payments || {}).captures) || [])[0] || {};
  const amount = Number((cap.amount && cap.amount.value) || 0);
  const payerEmail = (captured.payer && captured.payer.email_address) || null;

  return {
    mode:        "paypal",
    order_id:    captured.id,
    capture_id:  cap.id || null,
    status:      captured.status,
    amount_usd:  amount,
    payer_email: payerEmail,
    raw:         captured,
  };
}

/**
 * Refund a previously captured PayPal payment.
 *
 * @param {string} captureId   The capture id from the original capture
 * @param {Object} [opts]
 * @param {number} [opts.amountUsd]  Partial refund amount. Omit for full refund.
 * @param {string} [opts.note]       Refund note that shows in PayPal dashboard
 *
 * @returns {Object} { mode, refund_id, status, amount_usd, raw }
 */
async function refundCapture(captureId, opts = {}) {
  if (!captureId) throw new Error("refundCapture: captureId required");

  if (!hasCreds()) {
    return {
      mode:       "demo",
      refund_id:  "REFUND_DEMO_" + Math.random().toString(36).slice(2, 10).toUpperCase(),
      status:     "COMPLETED",
      amount_usd: Number(opts.amountUsd) || 0,
      raw:        { _demo: true, status: "COMPLETED" },
    };
  }

  const body = {};
  if (opts.amountUsd != null) {
    body.amount = {
      currency_code: "USD",
      value:         Number(opts.amountUsd).toFixed(2),
    };
  }
  if (opts.note) body.note_to_payer = opts.note;

  const refund = await _paypalFetch(`/v2/payments/captures/${captureId}/refund`, {
    method:    "POST",
    body,
    requestId: opts.requestId || undefined,
  });

  return {
    mode:       "paypal",
    refund_id:  refund.id,
    status:     refund.status,
    amount_usd: Number((refund.amount && refund.amount.value) || 0),
    raw:        refund,
  };
}

async function getOrder(orderId) {
  if (!orderId) throw new Error("getOrder: orderId required");
  if (!hasCreds()) {
    return { mode: "demo", order_id: orderId, status: "CREATED", raw: { id: orderId, status: "CREATED", _demo: true } };
  }
  const order = await _paypalFetch(`/v2/checkout/orders/${orderId}`);
  return { mode: "paypal", order_id: order.id, status: order.status, raw: order };
}

// ────────────────────────────────────────────────────────────────────
//                              WEBHOOKS
// ────────────────────────────────────────────────────────────────────
//
// PayPal webhook signature verification works differently from Stripe:
// instead of computing an HMAC locally, we POST the headers + body
// back to PayPal's verify-webhook-signature endpoint and they tell us
// SUCCESS or FAILURE. That requires a network round-trip per event,
// but it's the documented mechanism.

/**
 * Verify a webhook signature against PayPal's verify-webhook-signature endpoint.
 *
 * @param {Object} args
 * @param {Object} args.headers   The incoming request headers (case-insensitive)
 * @param {string} args.rawBody   The raw bytes of the webhook body as a string
 * @param {string} [args.webhookId] Override for PAYPAL_WEBHOOK_ID (mostly for tests)
 *
 * @returns {Object} { verified, mode, status, raw }
 */
async function verifyWebhook({ headers, rawBody, webhookId } = {}) {
  if (!headers || typeof rawBody !== "string") {
    return { verified: false, mode: hasCreds() ? "paypal" : "demo", status: "MISSING_INPUT" };
  }

  const wid = webhookId || process.env.PAYPAL_WEBHOOK_ID;

  if (!hasCreds() || !wid) {
    // Demo mode: accept without verification but tag as untrusted so the
    // caller logs/treats it accordingly (same convention Stripe demo uses).
    return { verified: true, mode: "demo", status: "ACCEPTED_UNTRUSTED" };
  }

  // PayPal's verify-webhook-signature accepts headers as named fields.
  // Lower-case lookup because Node request headers are normalized.
  const h = {};
  for (const k of Object.keys(headers)) h[k.toLowerCase()] = headers[k];

  let webhookEvent;
  try { webhookEvent = JSON.parse(rawBody); }
  catch (_) {
    return { verified: false, mode: "paypal", status: "INVALID_JSON" };
  }

  const verifyBody = {
    auth_algo:         h["paypal-auth-algo"],
    cert_url:          h["paypal-cert-url"],
    transmission_id:   h["paypal-transmission-id"],
    transmission_sig:  h["paypal-transmission-sig"],
    transmission_time: h["paypal-transmission-time"],
    webhook_id:        wid,
    webhook_event:     webhookEvent,
  };

  const result = await _paypalFetch("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body:   verifyBody,
  });

  return {
    verified: result.verification_status === "SUCCESS",
    mode:     "paypal",
    status:   result.verification_status,
    raw:      result,
  };
}

// ────────────────────────────────────────────────────────────────────
module.exports = {
  // public API
  createOrder,           // advertiser deposit flow
  captureOrder,
  refundCapture,
  getOrder,
  verifyWebhook,
  // helpers (mostly for tests / introspection)
  hasCreds,
  getEnv,
  getBaseUrl,
  _resetTokenCache,
};
