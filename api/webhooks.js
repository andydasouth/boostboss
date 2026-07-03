/**
 * Boost Boss — advertiser webhook management (demand-side harness)
 *
 *   GET  /api/webhooks                    → list this advertiser's webhooks (secrets masked)
 *   POST /api/webhooks                    → create { name, url, events[] } — returns the secret ONCE
 *   POST /api/webhooks?action=toggle      → { id, active }
 *   POST /api/webhooks?action=delete      → { id }
 *
 * Auth: the advertiser's session JWT OR a bb_live_ API key (Bearer), resolved
 * by resolveAdvertiser — same as every other demand-side endpoint.
 * Secrets are show-once (returned only at creation), never re-listed in full.
 */

const { createClient } = require("@supabase/supabase-js");
const { resolveAdvertiser } = require("./_lib/advertiser_auth.js");
const { newWebhookSecret } = require("./_lib/webhook_delivery.js");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "";
const HAS_SUPABASE = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

// Events an advertiser can subscribe to. '*' = all.
const VALID_EVENTS = [
  "campaign.created", "campaign.approved", "campaign.rejected",
  "campaign.paused", "campaign.resumed", "campaign.budget_exhausted",
  "conversion.recorded",
];

let _sb = null;
function sb() {
  if (_sb) return _sb;
  if (!HAS_SUPABASE) return null;
  _sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  return _sb;
}

// Demo store (no Supabase): advertiserId -> [ {id,name,url,events,active,...} ]
const _demo = new Map();

function mask(secret) {
  if (!secret) return null;
  return secret.slice(0, 11) + "…"; // whsec_XXXX…
}
function isHttpsUrl(u) {
  try { const p = new URL(u); return p.protocol === "https:" || p.protocol === "http:"; }
  catch (_) { return false; }
}
function cleanEvents(events) {
  if (!Array.isArray(events)) return [];
  const set = events.map(String);
  if (set.includes("*")) return ["*"];
  return set.filter((e) => VALID_EVENTS.includes(e));
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",
    HAS_SUPABASE ? (process.env.BOOSTBOSS_BASE_URL || "https://boostboss.ai") : "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const cli = sb();

  // Resolve the advertiser (session JWT or bb_live_ key).
  let advertiserId;
  if (cli) {
    const auth = await resolveAdvertiser(req, cli);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    advertiserId = auth.advertiserId;
  } else {
    // Demo mode — any bearer maps to the demo advertiser.
    const bearer = ((req.headers && req.headers.authorization) || "").replace(/^Bearer\s+/i, "").trim();
    if (!bearer) return res.status(401).json({ error: "Sign in required" });
    advertiserId = "adv_demo";
  }

  const action = (req.query && req.query.action) || (req.body && req.body.action) || "";

  // ── GET — list (secrets masked) ──
  if (req.method === "GET") {
    if (!cli) {
      const list = (_demo.get(advertiserId) || []).map((w) => ({ ...w, secret: mask(w.secret) }));
      return res.json({ webhooks: list, valid_events: VALID_EVENTS });
    }
    const { data } = await cli.from("advertiser_webhooks")
      .select("id, name, url, events, active, created_at, last_delivery_at, last_status, secret")
      .eq("advertiser_id", advertiserId).order("created_at", { ascending: false });
    const webhooks = (data || []).map((w) => ({ ...w, secret: mask(w.secret) }));
    return res.json({ webhooks, valid_events: VALID_EVENTS });
  }

  if (req.method === "POST") {
    // ── toggle active ──
    if (action === "toggle") {
      const idv = req.body && req.body.id;
      const active = !!(req.body && req.body.active);
      if (!idv) return res.status(400).json({ error: "id required" });
      if (!cli) {
        const list = _demo.get(advertiserId) || [];
        const w = list.find((x) => x.id === idv); if (w) w.active = active;
        return res.json({ ok: true });
      }
      await cli.from("advertiser_webhooks").update({ active })
        .eq("id", idv).eq("advertiser_id", advertiserId);
      return res.json({ ok: true });
    }

    // ── delete ──
    if (action === "delete") {
      const idv = req.body && req.body.id;
      if (!idv) return res.status(400).json({ error: "id required" });
      if (!cli) {
        _demo.set(advertiserId, (_demo.get(advertiserId) || []).filter((x) => x.id !== idv));
        return res.json({ ok: true });
      }
      await cli.from("advertiser_webhooks").delete()
        .eq("id", idv).eq("advertiser_id", advertiserId);
      return res.json({ ok: true });
    }

    // ── create ──
    const { name, url } = req.body || {};
    const events = cleanEvents(req.body && req.body.events);
    if (!url || !isHttpsUrl(url)) return res.status(400).json({ error: "A valid https URL is required" });
    if (events.length === 0) return res.status(400).json({ error: "Select at least one event (or '*')" });
    const secret = newWebhookSecret();

    if (!cli) {
      const rec = {
        id: "wh_" + Math.random().toString(36).slice(2, 10),
        name: name || null, url, events, active: true,
        created_at: new Date().toISOString(), last_delivery_at: null, last_status: null, secret,
      };
      const list = _demo.get(advertiserId) || []; list.push(rec); _demo.set(advertiserId, list);
      return res.json({ ok: true, webhook: { ...rec, secret: mask(secret) }, secret });
    }
    const { data, error } = await cli.from("advertiser_webhooks").insert({
      advertiser_id: advertiserId, name: name || null, url, events, active: true, secret,
    }).select("id, name, url, events, active, created_at").single();
    if (error) {
      console.error("[webhooks] create error:", error.message);
      return res.status(500).json({ error: "Could not create webhook." });
    }
    // Secret returned ONCE, in the clear, at creation.
    return res.json({ ok: true, webhook: { ...data, secret: mask(secret) }, secret });
  }

  return res.status(405).json({ error: "Method not allowed" });
};

module.exports.VALID_EVENTS = VALID_EVENTS;
