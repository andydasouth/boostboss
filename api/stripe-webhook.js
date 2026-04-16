/**
 * Boost Boss — Stripe webhook receiver
 *
 * Stripe signature verification requires the EXACT raw bytes of the
 * request body — Vercel's default JSON body parser strips this. This
 * route exists separately from /api/billing so we can disable parsing
 * here while leaving the rest of the billing API unchanged.
 *
 * Configure your Stripe webhook to point at:
 *   https://boostboss.ai/api/stripe-webhook
 *
 * Required env:
 *   STRIPE_SECRET_KEY      — sk_live_... or sk_test_...
 *   STRIPE_WEBHOOK_SECRET  — whsec_...   (from the webhook endpoint config)
 */

// Disable Vercel's body parser so we can read the raw bytes Stripe signs against.
module.exports.config = { api: { bodyParser: false } };

const billing = require("./billing.js");

async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let raw = "";
  try { raw = await readRawBody(req); }
  catch (e) { return res.status(400).json({ error: "could not read body: " + e.message }); }

  // Stripe needs both the raw bytes AND the parsed event for downstream logic.
  // We attach rawBody so billing.handleWebhook's signature check works, then
  // synthesize req.body from the JSON for the demo-mode path.
  req.rawBody = raw;
  try { req.body = JSON.parse(raw); }
  catch (_) { req.body = null; }

  // Reuse the existing webhook handler in billing.js
  req.query = Object.assign({}, req.query, { action: "webhook" });
  return billing(req, res);
};
