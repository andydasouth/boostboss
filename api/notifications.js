/**
 * Boost Boss — Notifications feed API
 *
 *   GET  /api/notifications?action=list        → { notifications:[...], unread }
 *   POST /api/notifications?action=mark_read   → { ok:true }   (body: { id? })
 *
 * Auth: Authorization: Bearer <session JWT | bb_live_ key> (resolveAdvertiser).
 * DEMO mode (no Supabase configured) returns a small sample so the UI works.
 * On first list for a real account with zero rows, seeds starter notifications
 * so the feed is never empty on a fresh account.
 */

const HAS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
);
const { resolveAdvertiser } = require("./_lib/advertiser_auth.js");

let _supabase = null;
function supa() {
  if (_supabase) return _supabase;
  if (!HAS_SUPABASE) return null;
  try {
    const { createClient } = require("@supabase/supabase-js");
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    );
    return _supabase;
  } catch (_) { return null; }
}

const _NOW = () => Date.now();
function sampleItems() {
  return [
    { id: "s1", icon: "⚡", title: "Credits earned", body: "You earned 1,240 Credits hosting ads on your surface today.", time: _NOW() - 3600000 * 2, unread: true },
    { id: "s2", icon: "🎯", title: "Your product got clicks", body: "38 people clicked through to your product from AI-native placements this week.", time: _NOW() - 86400000, unread: true },
    { id: "s3", icon: "🔌", title: "SDK connected", body: "Your Browser App door is verified and serving ads. Credits are now accruing.", time: _NOW() - 86400000 * 3, unread: false },
  ];
}

// Starter feed for a brand-new account (persisted once).
const STARTER = [
  { kind: "welcome", icon: "🚀", title: "Welcome to Boost Boss", body: "List your product, install the SDK to host ads, and start earning Credits you can spend to get discovered." },
  { kind: "getting_started", icon: "🔌", title: "Install the SDK to unlock 37 placements", body: "Hosting ads on your surface earns Credits and unlocks every AI-native placement across the network — free." },
];

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  const allowed = ["https://boostboss.ai", "https://www.boostboss.ai"];
  res.setHeader("Access-Control-Allow-Origin", allowed.includes(origin) ? origin : "https://boostboss.ai");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = (req.query && req.query.action) || "list";
  const sb = supa();

  // Demo mode — no DB. Return a small sample so the console still works.
  if (!sb) {
    if (req.method === "POST" && action === "mark_read") return res.json({ ok: true, demo: true });
    const items = sampleItems();
    return res.json({ notifications: items, unread: items.filter((i) => i.unread).length, demo: true });
  }

  const auth = await resolveAdvertiser(req, sb);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const acct = auth.advertiserId;

  try {
    if (req.method === "POST" && action === "mark_read") {
      let id = null;
      try { id = (req.body && req.body.id) || null; } catch (_) {}
      let q = sb.from("notifications").update({ read_at: new Date().toISOString() })
        .eq("account_id", acct).is("read_at", null);
      if (id) q = q.eq("id", id);
      const { error } = await q;
      if (error && error.code !== "42P01") return res.status(500).json({ error: error.message });
      return res.json({ ok: true });
    }

    // GET list
    let { data, error } = await sb.from("notifications")
      .select("*").eq("account_id", acct)
      .order("created_at", { ascending: false }).limit(30);
    if (error) {
      if (error.code === "42P01") return res.json({ notifications: [], unread: 0, no_table: true });
      return res.status(500).json({ error: error.message });
    }

    // Seed starter notifications once for a fresh account.
    if (!data || data.length === 0) {
      try {
        await sb.from("notifications").insert(STARTER.map((s) => ({ account_id: acct, ...s })));
        const re = await sb.from("notifications").select("*").eq("account_id", acct)
          .order("created_at", { ascending: false }).limit(30);
        data = re.data || [];
      } catch (_) { data = []; }
    }

    const items = (data || []).map((n) => ({
      id: n.id, icon: n.icon, title: n.title, body: n.body,
      time: new Date(n.created_at).getTime(), unread: !n.read_at,
    }));
    return res.json({ notifications: items, unread: items.filter((i) => i.unread).length });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || "Notifications error" });
  }
};
