/**
 * Boost Boss — Auth API
 *
 * Two execution modes:
 *  • PRODUCTION  — Supabase (when SUPABASE_URL + SUPABASE_ANON_KEY are set)
 *  • DEMO        — in-process HMAC-signed JWTs (zero external deps, perfect
 *                  for live demos, the BBX sandbox, and CI environments)
 *
 * Both modes expose the same interface so the front-end never has to branch.
 *
 *   POST /api/auth?action=signup    { email, password, role, company_name?, app_name? }
 *   POST /api/auth?action=login     { email, password }
 *   POST /api/auth?action=demo      { role }                  ← demo only
 *   POST /api/auth?action=me        Authorization: Bearer <token>
 *   POST /api/auth?action=logout    Authorization: Bearer <token>
 */

const crypto = require("crypto");

// ── environment sniff ───────────────────────────────────────────────
const HAS_SUPABASE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
const JWT_SECRET = process.env.JWT_SECRET || "bbx-demo-jwt-secret-do-not-use-in-prod";
const TOKEN_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

// ── lazy Supabase loader (so demo mode has zero deps) ───────────────
let _createClient = null;
function loadSupabase() {
  if (_createClient) return _createClient;
  try {
    _createClient = require("@supabase/supabase-js").createClient;
  } catch (e) {
    console.warn("[Auth] @supabase/supabase-js not installed — demo mode only.");
  }
  return _createClient;
}

// ── HMAC-signed JWT (HS256) ─────────────────────────────────────────
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64").toString("utf8");
}
function signJwt(payload) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", JWT_SECRET).update(header + "." + body).digest());
  return header + "." + body + "." + sig;
}
function verifyJwt(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  const expected = b64url(crypto.createHmac("sha256", JWT_SECRET).update(h + "." + b).digest());
  if (s !== expected) return null;
  try {
    const payload = JSON.parse(b64urlDecode(b));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ── deterministic demo user IDs ─────────────────────────────────────
function userIdFromEmail(email) {
  return "u_" + crypto.createHash("sha256").update(email.toLowerCase().trim()).digest("hex").slice(0, 16);
}
function makeApiKey(prefix, userId) {
  const seed = crypto.createHash("sha256").update(prefix + ":" + userId + ":" + JWT_SECRET).digest("hex");
  return `bb_${prefix}_live_${seed.slice(0, 32)}`;
}

// ── demo-mode in-process user store (resets on cold start; that's fine) ──
const DEMO_USERS = new Map(); // userId → user row

function demoUpsert(email, role, extras = {}) {
  const id = userIdFromEmail(email);
  const existing = DEMO_USERS.get(id);
  const now = new Date().toISOString();
  const user = existing || {
    id, email, role,
    created_at: now,
    profile: role === "advertiser"
      ? {
          company_name: extras.company_name || email.split("@")[0],
          balance: 5000.00,
          monthly_spend: 12480.32,
          active_campaigns: 4,
          impressions_30d: 2_140_817,
          api_key: makeApiKey("adv", id),
        }
      : {
          app_name: extras.app_name || "My AI App",
          monthly_revenue: 18920.55,
          active_publishers: 1,
          ad_requests_30d: 4_312_006,
          fill_rate: 0.812,
          api_key: makeApiKey("dev", id),
        },
  };
  DEMO_USERS.set(id, user);
  return user;
}

function tokenFor(user) {
  return signJwt({
    sub: user.id,
    email: user.email,
    role: user.role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC,
    iss: "boostboss.ai",
  });
}

// ────────────────────────────────────────────────────────────────────
//                              HANDLER
// ────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Restrict CORS in production to BoostBoss origins; allow * in demo for local dev
  const PUBLIC_BASE = process.env.BOOSTBOSS_BASE_URL || "https://boostboss.ai";
  if (HAS_SUPABASE) {
    const origin = req.headers && req.headers.origin;
    const allowed = ["https://boostboss.ai", "https://www.boostboss.ai", PUBLIC_BASE];
    res.setHeader("Access-Control-Allow-Origin", allowed.includes(origin) ? origin : PUBLIC_BASE);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("x-auth-mode", HAS_SUPABASE ? "supabase" : "demo");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const action = (req.query && req.query.action) || (req.body && req.body.action);
  const body = req.body || {};

  try {
    // ── DEMO MODE ─────────────────────────────────────────────────
    if (!HAS_SUPABASE) return demoHandler(action, body, req, res);

    // ── SUPABASE MODE ─────────────────────────────────────────────
    return supabaseHandler(action, body, req, res);
  } catch (err) {
    console.error("[Auth Error]", err);
    return res.status(500).json({ error: err.message });
  }
};

// ────────────────────── DEMO IMPLEMENTATION ─────────────────────────
function demoHandler(action, body, req, res) {
  // Quick-start: no email/password required, synthesize a fresh account.
  // This is what the "Try the demo" button on the dashboards calls.
  if (action === "demo") {
    const role = body.role === "developer" ? "developer" : "advertiser";
    const ts = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
    const email = `demo-${ts}@boostboss.ai`;
    const company_name = role === "advertiser" ? "Demo Co." : undefined;
    const app_name = role === "developer" ? "Demo MCP App" : undefined;
    const user = demoUpsert(email, role, { company_name, app_name });
    return res.json({
      success: true,
      mode: "demo",
      user: { id: user.id, email: user.email, role: user.role },
      profile: user.profile,
      session: { access_token: tokenFor(user), expires_in: TOKEN_TTL_SEC, token_type: "Bearer" },
    });
  }

  if (action === "signup") {
    const { email, password, role, company_name, app_name } = body;
    if (!email || !password || !role) return res.status(400).json({ error: "Missing email, password, or role" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (!["advertiser", "developer"].includes(role)) return res.status(400).json({ error: "role must be advertiser or developer" });
    const user = demoUpsert(email, role, { company_name, app_name });
    return res.json({
      success: true,
      mode: "demo",
      user: { id: user.id, email: user.email, role: user.role },
      profile: user.profile,
      session: { access_token: tokenFor(user), expires_in: TOKEN_TTL_SEC, token_type: "Bearer" },
    });
  }

  if (action === "login") {
    const { email, password } = body;
    if (!email || !password) return res.status(400).json({ error: "Missing email or password" });
    // In demo mode, any login auto-creates an advertiser if unknown — friction-free for evaluators.
    const id = userIdFromEmail(email);
    let user = DEMO_USERS.get(id);
    if (!user) user = demoUpsert(email, "advertiser");
    return res.json({
      success: true,
      mode: "demo",
      user: { id: user.id, email: user.email, role: user.role },
      profile: user.profile,
      session: { access_token: tokenFor(user), expires_in: TOKEN_TTL_SEC, token_type: "Bearer" },
    });
  }

  if (action === "me") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const claims = verifyJwt(token);
    if (!claims) return res.status(401).json({ error: "Invalid or expired token" });
    let user = DEMO_USERS.get(claims.sub);
    if (!user) user = demoUpsert(claims.email, claims.role); // re-hydrate if cold-start lost it
    return res.json({
      mode: "demo",
      user: { id: user.id, email: user.email, role: user.role },
      profile: user.profile,
    });
  }

  if (action === "logout") {
    // JWTs are stateless — client just discards the token. Acknowledge for UX symmetry.
    return res.json({ success: true, mode: "demo" });
  }

  // Update a publisher's accepted ad formats. The auction reads this to filter
  // campaigns so publishers only receive formats they've opted into.
  if (action === "update_formats") {
    const { api_key, formats } = body;
    if (!api_key || !formats) return res.status(400).json({ error: "Missing api_key or formats" });
    // Demo mode: find the developer by api_key and update in-memory.
    for (const user of DEMO_USERS.values()) {
      if (user.profile?.api_key === api_key) {
        user.profile.formats = { ...(user.profile.formats || {}), ...formats };
        return res.json({ success: true, mode: "demo", formats: user.profile.formats });
      }
    }
    return res.status(404).json({ error: "Developer not found" });
  }

  return res.status(400).json({ error: "Unknown action. Use: demo, signup, login, me, logout, update_formats" });
}

// ─────────────────── SUPABASE IMPLEMENTATION ────────────────────────
async function supabaseHandler(action, body, req, res) {
  const createClient = loadSupabase();
  if (!createClient) {
    return res.status(500).json({ error: "Supabase configured but @supabase/supabase-js not installed" });
  }
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  const supabaseAdmin = createClient(process.env.SUPABASE_URL, serviceKey);
  const supabaseAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  if (action === "demo") {
    // Even in production, allow a one-click demo path that creates a real account.
    const role = body.role === "developer" ? "developer" : "advertiser";
    const email = `demo-${Date.now().toString(36)}@boostboss.demo`;
    const password = crypto.randomBytes(16).toString("hex");
    body.email = email; body.password = password; body.role = role;
    body.company_name = role === "advertiser" ? "Demo Co." : undefined;
    body.app_name = role === "developer" ? "Demo MCP App" : undefined;
    return signupSupabase(supabaseAdmin, supabaseAnon, body, res);
  }

  if (action === "signup") return signupSupabase(supabaseAdmin, supabaseAnon, body, res);

  if (action === "login") {
    const { email, password } = body;
    if (!email || !password) return res.status(400).json({ error: "Missing email or password" });
    const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });
    const role = data.user?.user_metadata?.role || "unknown";
    let profile = null;
    if (role === "advertiser") {
      const { data: adv } = await supabaseAdmin.from("advertisers").select("*").eq("id", data.user.id).single();
      profile = adv;
    } else if (role === "developer") {
      const { data: dev } = await supabaseAdmin.from("developers").select("*").eq("id", data.user.id).single();
      profile = dev;
      // Ensure API key exists (backfill for developers created before api_key column was added)
      if (profile && !profile.api_key) {
        const apiKey = makeApiKey("dev", data.user.id);
        await supabaseAdmin.from("developers").update({ api_key: apiKey }).eq("id", data.user.id);
        profile.api_key = apiKey;
      }
    }
    return res.json({
      success: true, mode: "supabase",
      user: { id: data.user.id, email: data.user.email, role }, profile,
      session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token },
    });
  }

  if (action === "me") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "No token" });
    const { data: { user }, error } = await supabaseAnon.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid token" });
    const role = user.user_metadata?.role || "unknown";
    let profile = null;
    if (role === "advertiser") {
      const { data } = await supabaseAdmin.from("advertisers").select("*").eq("id", user.id).single();
      profile = data;
    } else if (role === "developer") {
      const { data } = await supabaseAdmin.from("developers").select("*").eq("id", user.id).single();
      profile = data;
    }
    return res.json({ mode: "supabase", user: { id: user.id, email: user.email, role }, profile });
  }

  if (action === "logout") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (token) await supabaseAnon.auth.signOut();
    return res.json({ success: true, mode: "supabase" });
  }

  if (action === "update_formats") {
    const { api_key, formats } = body;
    if (!api_key || !formats) return res.status(400).json({ error: "Missing api_key or formats" });
    // Schema stores format prefs as individual boolean columns for indexing
    // clarity (format_native, format_image, format_corner, format_video,
    // format_fullscreen). Translate the JSON toggles the client sent into
    // column updates, ignoring unknown keys.
    const columnMap = {
      native:     "format_native",
      image:      "format_image",
      corner:     "format_corner",
      video:      "format_video",
      fullscreen: "format_fullscreen",
    };
    const updates = {};
    for (const [key, value] of Object.entries(formats)) {
      const col = columnMap[key];
      if (col) updates[col] = !!value;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No recognized format keys" });
    }
    const { data: dev, error: lookupErr } = await supabaseAdmin
      .from("developers")
      .select("id")
      .eq("api_key", api_key)
      .single();
    if (lookupErr || !dev) return res.status(404).json({ error: "Developer not found" });
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("developers")
      .update(updates)
      .eq("id", dev.id)
      .select("format_native, format_image, format_corner, format_video, format_fullscreen")
      .single();
    if (updateErr) return res.status(500).json({ error: updateErr.message });
    return res.json({
      success: true,
      mode: "supabase",
      formats: {
        native:     updated.format_native,
        image:      updated.format_image,
        corner:     updated.format_corner,
        video:      updated.format_video,
        fullscreen: updated.format_fullscreen,
      },
    });
  }

  return res.status(400).json({ error: "Unknown action. Use: demo, signup, login, me, logout, update_formats" });
}

async function signupSupabase(supabaseAdmin, supabaseAnon, body, res) {
  const { email, password, role, company_name, app_name } = body;
  if (!email || !password || !role) return res.status(400).json({ error: "Missing email, password, or role" });

  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { role, company_name, app_name },
  });
  if (authErr) return res.status(400).json({ error: authErr.message });

  const userId = authData.user?.id;

  if (role === "advertiser") {
    const { error } = await supabaseAdmin.from("advertisers").insert({
      id: userId, email, company_name: company_name || email.split("@")[0], balance: 0,
    });
    if (error) console.error("[Auth] Advertiser insert error:", error.message);
  } else if (role === "developer") {
    const apiKey = makeApiKey("dev", userId);
    const { error } = await supabaseAdmin.from("developers").insert({
      id: userId, email, app_name: app_name || "My AI App",
      api_key: apiKey, status: "active",
    });
    if (error) console.error("[Auth] Developer insert error:", error.message);
  }

  const { data: signInData, error: signInErr } = await supabaseAnon.auth.signInWithPassword({ email, password });

  // Build profile with API key for developers
  let profile;
  if (role === "advertiser") {
    profile = { company_name: company_name || email.split("@")[0], balance: 0 };
  } else {
    const apiKey = makeApiKey("dev", userId);
    profile = { app_name: app_name || "My AI App", api_key: apiKey };
  }

  return res.json({
    success: true, mode: "supabase",
    user: { id: userId, email, role },
    profile,
    session: signInErr ? null : {
      access_token: signInData.session.access_token,
      refresh_token: signInData.session.refresh_token,
    },
  });
}

// ── exports for testing ─────────────────────────────────────────────
module.exports.signJwt = signJwt;
module.exports.verifyJwt = verifyJwt;
module.exports.userIdFromEmail = userIdFromEmail;
module.exports.HAS_SUPABASE = HAS_SUPABASE;
