/**
 * Boost Boss — advertiser webhook delivery
 *
 * deliverWebhook(sb, advertiserId, event, payload)
 *   Looks up the advertiser's active webhooks subscribed to `event` (or '*'),
 *   and POSTs an HMAC-SHA256-signed JSON body to each. Fire-and-safe: never
 *   throws, best-effort records last_delivery_at / last_status. Backs the
 *   demand-side harness so agents get push events instead of polling.
 *
 * Signature (Stripe-style):
 *   X-BoostBoss-Timestamp: <unix seconds>
 *   X-BoostBoss-Signature: sha256=<hex hmac of "{timestamp}.{body}">
 *   X-BoostBoss-Event:     <event name>
 * Verify: hmac(secret, `${timestamp}.${rawBody}`) === signature.
 */

const crypto = require("crypto");

function sign(secret, timestamp, body) {
  return "sha256=" + crypto.createHmac("sha256", secret)
    .update(timestamp + "." + body).digest("hex");
}

// Generate a webhook signing secret (returned once at registration).
function newWebhookSecret() {
  return "whsec_" + crypto.randomBytes(24).toString("base64url");
}

async function postOne(hook, event, bodyStr) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(hook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BoostBoss-Event": event,
        "X-BoostBoss-Timestamp": ts,
        "X-BoostBoss-Signature": sign(hook.secret, ts, bodyStr),
        "User-Agent": "BoostBoss-Webhooks/1.0",
      },
      body: bodyStr,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return r.status;
  } catch (_e) {
    clearTimeout(timer);
    return 0; // network error / timeout
  }
}

async function deliverWebhook(sb, advertiserId, event, payload) {
  if (!sb || !advertiserId || !event) return;
  try {
    const { data: hooks } = await sb
      .from("advertiser_webhooks")
      .select("id, url, secret, events")
      .eq("advertiser_id", advertiserId)
      .eq("active", true);
    if (!Array.isArray(hooks) || hooks.length === 0) return;

    const subscribed = hooks.filter((h) => {
      const evs = Array.isArray(h.events) ? h.events : [];
      return evs.includes("*") || evs.includes(event);
    });
    if (subscribed.length === 0) return;

    const bodyStr = JSON.stringify({
      event,
      created: Math.floor(Date.now() / 1000),
      data: payload || {},
    });

    await Promise.all(subscribed.map(async (h) => {
      const status = await postOne(h, event, bodyStr);
      try {
        await sb.from("advertiser_webhooks")
          .update({ last_delivery_at: new Date().toISOString(), last_status: status })
          .eq("id", h.id);
      } catch (_) { /* best-effort */ }
    }));
  } catch (e) {
    console.error("[webhooks] delivery failed:", e && e.message);
  }
}

module.exports = { deliverWebhook, newWebhookSecret, sign };
