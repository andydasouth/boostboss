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
 *   POST /api/auth?action=signup      { email, password, role, company_name?, app_name? }
 *   POST /api/auth?action=login       { email, password }
 *   POST /api/auth?action=demo        { role }                  ← demo only
 *   POST /api/auth?action=oauth_sync  { role }  Authorization: Bearer <supabase-oauth-token>
 *   POST /api/auth?action=me          Authorization: Bearer <token>
 *   POST /api/auth?action=logout      Authorization: Bearer <token>
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

  if (action === "oauth_sync") {
    // Demo mode has no Supabase; OAuth isn't available here.
    return res.status(501).json({ error: "Google sign-in requires Supabase — demo mode doesn't support OAuth. Use email + password or try the demo." });
  }

  return res.status(400).json({ error: "Unknown action. Use: demo, signup, login, oauth_sync, me, logout, update_formats" });
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
    const { email, password, role: wantedRoleRaw } = body;
    if (!email || !password) return res.status(400).json({ error: "Missing email or password" });
    const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });

    // Two-product sign-in: the role is decided by the URL the user came
    // from (e.g. /publish/signin vs /ads/signin). We only return the
    // profile matching that role — so a publisher signing in on /ads
    // gets a clean "no advertiser account, sign up first" error.
    const wantedRole =
      wantedRoleRaw === "developer" || wantedRoleRaw === "advertiser"
        ? wantedRoleRaw
        : (data.user?.user_metadata?.role || "advertiser");

    let profile = null;
    if (wantedRole === "advertiser") {
      const { data: adv } = await supabaseAdmin.from("advertisers").select("*").eq("id", data.user.id).maybeSingle();
      profile = adv;
    } else if (wantedRole === "developer") {
      const { data: dev } = await supabaseAdmin.from("developers").select("*").eq("id", data.user.id).maybeSingle();
      profile = dev;
      if (profile && !profile.api_key) {
        const apiKey = makeApiKey("dev", data.user.id);
        await supabaseAdmin.from("developers").update({ api_key: apiKey }).eq("id", data.user.id);
        profile.api_key = apiKey;
      }
    }

    if (!profile) {
      const product = wantedRole === "advertiser" ? "SuperBoost Ads" : "Lumi SDK";
      return res.status(404).json({
        error: "This email isn't registered for " + product + ". Please sign up first.",
      });
    }

    return res.json({
      success: true, mode: "supabase",
      user: { id: data.user.id, email: data.user.email, role: wantedRole },
      profile,
      session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token },
    });
  }

  if (action === "me") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "No token" });
    const { data: { user }, error } = await supabaseAnon.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid token" });
    // An account can hold profiles for BOTH products (/publish dev + /ads
    // advertiser). The caller tells us which product's dashboard it is,
    // via { role: "developer" | "advertiser" } in the body. When the
    // caller doesn't specify, fall back to user_metadata.role (the last
    // role the user actively signed in with).
    const wantedRaw = body && body.role;
    const role = (wantedRaw === "developer" || wantedRaw === "advertiser")
      ? wantedRaw
      : (user.user_metadata?.role || "unknown");
    let profile = null;
    if (role === "advertiser") {
      const { data } = await supabaseAdmin.from("advertisers").select("*").eq("id", user.id).maybeSingle();
      profile = data;
    } else if (role === "developer") {
      const { data } = await supabaseAdmin.from("developers").select("*").eq("id", user.id).maybeSingle();
      profile = data;
      if (profile && !profile.api_key) {
        const apiKey = makeApiKey("dev", user.id);
        await supabaseAdmin.from("developers").update({ api_key: apiKey }).eq("id", user.id);
        profile.api_key = apiKey;
      }
    }
    return res.json({ mode: "supabase", user: { id: user.id, email: user.email, role }, profile });
  }

  if (action === "oauth_sync") {
    // Called after a successful Google OAuth return. The frontend sends
    // the Supabase access_token + the role implied by the URL path. We
    // verify the token, ensure the profile row for THAT role exists
    // (creating it on first visit, adding it alongside any other role
    // the user may already have), and return the same shape as
    // signup/login so the frontend can persist the session and redirect.
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "No token" });
    const { data: { user }, error } = await supabaseAnon.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid OAuth token" });

    // Role ALWAYS comes from the URL path the user is on (passed in body),
    // not from existing user_metadata. Publisher and Advertiser are two
    // separate products on the same auth user.
    const role = body.role === "developer" ? "developer" : "advertiser";

    // Ensure the profile row for this role exists (create on first time).
    let profile = null;
    if (role === "advertiser") {
      const { data: existing } = await supabaseAdmin
        .from("advertisers").select("*").eq("id", user.id).maybeSingle();
      if (existing) {
        profile = existing;
      } else {
        const fullName = user.user_metadata?.full_name
                      || user.user_metadata?.name
                      || (user.email || "").split("@")[0];
        const { data: inserted, error: insErr } = await supabaseAdmin
          .from("advertisers")
          .insert({ id: user.id, email: user.email, company_name: fullName, balance: 0 })
          .select("*").single();
        if (insErr) return res.status(500).json({ error: "Profile create failed: " + insErr.message });
        profile = inserted;
      }
    } else {
      const { data: existing } = await supabaseAdmin
        .from("developers").select("*").eq("id", user.id).maybeSingle();
      if (existing) {
        profile = existing;
        if (!profile.api_key) {
          const apiKey = makeApiKey("dev", user.id);
          await supabaseAdmin.from("developers").update({ api_key: apiKey }).eq("id", user.id);
          profile.api_key = apiKey;
        }
      } else {
        const apiKey = makeApiKey("dev", user.id);
        const fullName = user.user_metadata?.full_name
                      || user.user_metadata?.name
                      || "My AI App";
        const { data: inserted, error: insErr } = await supabaseAdmin
          .from("developers")
          .insert({ id: user.id, email: user.email, app_name: fullName, api_key: apiKey, status: "active" })
          .select("*").single();
        if (insErr) return res.status(500).json({ error: "Profile create failed: " + insErr.message });
        profile = inserted;
      }
    }

    // Merge the role into user_metadata.roles[] so future signins know
    // which products this account has profiles for.
    try {
      const existingMeta = user.user_metadata || {};
      const existingRoles = existingMeta.roles || (existingMeta.role ? [existingMeta.role] : []);
      const mergedRoles = Array.from(new Set([].concat(existingRoles, [role])));
      await supabaseAdmin.auth.admin.updateUserById(user.id, {
        user_metadata: Object.assign({}, existingMeta, { role, roles: mergedRoles }),
      });
    } catch (e) {
      console.warn("[Auth oauth_sync] user_metadata update failed:", e.message);
    }

    return res.json({
      success: true, mode: "supabase",
      user: { id: user.id, email: user.email, role },
      profile,
      session: { access_token: token, refresh_token: null },
    });
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

  return res.status(400).json({ error: "Unknown action. Use: demo, signup, login, oauth_sync, me, logout, update_formats" });
}

async function signupSupabase(supabaseAdmin, supabaseAnon, body, res) {
  const { email, password, role, company_name, app_name } = body;
  if (!email || !password || !role) return res.status(400).json({ error: "Missing email, password, or role" });
  if (role !== "advertiser" && role !== "developer") {
    return res.status(400).json({ error: "Invalid role" });
  }

  // Publisher (Lumi SDK) and Advertiser (SuperBoost Ads) are two separate
  // products. One email can register for both — we create/update a
  // profile row per role on the same Supabase auth user.
  let userId = null;
  let existingMeta = {};

  const initialMeta = { role };
  if (role === "advertiser" && company_name) initialMeta.company_name = company_name;
  if (role === "developer"  && app_name)     initialMeta.app_name     = app_name;

  const { data: createData, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: initialMeta,
  });

  if (createErr) {
    // Auth user likely already exists. Verify password, then attach the new role.
    const { data: siData, error: siErr } = await supabaseAnon.auth.signInWithPassword({ email, password });
    if (siErr || !siData.user) {
      return res.status(400).json({
        error: "This email is already registered. Please sign in or use a different email.",
      });
    }
    userId = siData.user.id;
    existingMeta = siData.user.user_metadata || {};

    // Refuse if this role's profile already exists.
    const table = role === "advertiser" ? "advertisers" : "developers";
    const { data: existingProfile } = await supabaseAdmin
      .from(table).select("id").eq("id", userId).maybeSingle();
    if (existingProfile) {
      const product = role === "advertiser" ? "SuperBoost Ads" : "Lumi SDK";
      return res.status(400).json({
        error: "This email is already registered for " + product + ". Please sign in instead.",
      });
    }
  } else {
    userId = createData.user?.id;
  }

  // Merge the new role into user_metadata.roles (array) so future logins can
  // see which products this account has profiles for.
  const existingRoles = existingMeta.roles || (existingMeta.role ? [existingMeta.role] : []);
  const mergedRoles = Array.from(new Set([].concat(existingRoles, [role])));
  const newMeta = Object.assign({}, existingMeta, { role, roles: mergedRoles });
  if (role === "advertiser" && company_name) newMeta.company_name = company_name;
  if (role === "developer"  && app_name)     newMeta.app_name     = app_name;
  try {
    await supabaseAdmin.auth.admin.updateUserById(userId, { user_metadata: newMeta });
  } catch (e) {
    console.warn("[Auth] user_metadata update failed:", e.message);
  }

  // Insert the missing profile row for this role.
  if (role === "advertiser") {
    const { error } = await supabaseAdmin.from("advertisers").insert({
      id: userId, email, company_name: company_name || email.split("@")[0], balance: 0,
    });
    if (error) console.error("[Auth] Advertiser insert error:", error.message);
  } else {
    const apiKey = makeApiKey("dev", userId);
    const { error } = await supabaseAdmin.from("developers").insert({
      id: userId, email, app_name: app_name || "My AI App",
      api_key: apiKey, status: "active",
    });
    if (error) console.error("[Auth] Developer insert error:", error.message);
  }

  const { data: signInData, error: signInErr } = await supabaseAnon.auth.signInWithPassword({ email, password });

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
