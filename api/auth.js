/**
 * Boost Boss — Auth API
 *
 * Two execution modes:
 *  • PRODUCTION  — Supabase (when SUPABASE_URL + SUPABASE_ANON_KEY are set)
 *  • IN-MEMORY   — HMAC-signed JWTs against an in-process user map. Used
 *                  for local dev, CI, and the BBX sandbox where there is
 *                  no Supabase configured. NOT a user-facing "demo mode".
 *
 * Both modes expose the same interface so the front-end never has to branch.
 *
 *   POST /api/auth?action=signup      { email, password, role, company_name?, app_name? }
 *   POST /api/auth?action=login       { email, password }
 *   POST /api/auth?action=oauth_sync  { role }  Authorization: Bearer <supabase-oauth-token>
 *   POST /api/auth?action=me          Authorization: Bearer <token>
 *   POST /api/auth?action=logout      Authorization: Bearer <token>
 *
 * The legacy `action=demo` quick-start endpoint was removed 2026-05-28
 * when the "Try the demo" buttons were dropped from the dashboards and
 * signup pages — no live demo accounts are offered any more.
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
//                  bb_session COOKIE — cross-origin auth
// ────────────────────────────────────────────────────────────────────
// Used purely so benna.ai (different root domain) can ask "is this user
// signed in?" via a CORS fetch with credentials: 'include'. The same JWT
// value also lives in localStorage on boostboss.ai for everything else —
// the cookie is purely additive.
//
// Security model:
//   - HttpOnly  → JS can't read the cookie; only the browser sends it.
//                 Reduces XSS impact (a stolen XSS payload can't exfil
//                 the session token from document.cookie).
//   - Secure    → only sent over HTTPS.
//   - SameSite=None → required so the browser sends it on the
//                     cross-origin fetch from benna.ai to boostboss.ai.
//   - Path=/    → available on every endpoint on boostboss.ai.
//
// CSRF: the cookie is used ONLY for the read-only me_cors action, which
// returns just { email, app_name, role }. State-changing endpoints
// still require the Bearer token in the Authorization header — which a
// CSRF attacker can't forge cross-origin. So the cookie identifies who;
// the Bearer token still authorizes what.
function setSessionCookie(res, token) {
  if (!token) return;
  const cookie = [
    "bb_session=" + token,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=None",
    "Max-Age=" + TOKEN_TTL_SEC,
  ].join("; ");
  // Append rather than overwrite so we don't clobber any other Set-Cookie
  // headers the response is already carrying.
  const prior = res.getHeader("Set-Cookie");
  if (!prior) {
    res.setHeader("Set-Cookie", cookie);
  } else if (Array.isArray(prior)) {
    res.setHeader("Set-Cookie", prior.concat(cookie));
  } else {
    res.setHeader("Set-Cookie", [prior, cookie]);
  }
}

// Read the bb_session value from the Cookie request header. Returns the
// JWT string (or null). Robust against extra cookies and missing header.
function readSessionCookie(req) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === "bb_session") return part.slice(eq + 1).trim();
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────
//                              HANDLER
// ────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Restrict CORS in production. Two trust circles:
  //   1. Same-origin (boostboss.ai, www.) — the main dashboard
  //   2. Cross-origin benna.ai — marketing site that needs to know whether
  //      the user is signed in so it can render an avatar + name lockup
  //      instead of the Sign-up CTA.
  // Cross-origin requests from benna.ai MUST send credentials (the
  // bb_session cookie) to read the me_cors response, so we have to:
  //   - echo the exact Origin header back (wildcard not allowed with credentials)
  //   - set Access-Control-Allow-Credentials: true
  //   - include cookie in Vary so cached responses don't leak across origins.
  const PUBLIC_BASE = process.env.BOOSTBOSS_BASE_URL || "https://boostboss.ai";
  const ALLOWED_ORIGINS = [
    "https://boostboss.ai",
    "https://www.boostboss.ai",
    "https://benna.ai",
    "https://www.benna.ai",
    PUBLIC_BASE,
  ];
  const reqOrigin = req.headers && req.headers.origin;
  if (HAS_SUPABASE) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : PUBLIC_BASE
    );
  } else {
    // Demo / dev — echo any origin so localhost works, but only when there
    // IS an origin (browsers send it on cross-origin fetches).
    res.setHeader("Access-Control-Allow-Origin", reqOrigin || "*");
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin, Cookie");
  res.setHeader("x-auth-mode", HAS_SUPABASE ? "supabase" : "demo");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = (req.query && req.query.action) || (req.body && req.body.action);
  const body = req.body || {};

  // Read-only actions allowed via GET. These are idempotent fetches with
  // no side effects; pagination params go in the query string. Everything
  // else still requires POST.
  //   - me_cors: benna.ai logged-in lockup (legacy)
  const GET_ALLOWED = new Set([
    "me_cors",
  ]);
  if (req.method === "GET" && !GET_ALLOWED.has(action)) {
    return res.status(405).json({ error: "GET not allowed for this action" });
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "POST only" });
  }

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

// ──────────────── IN-MEMORY MODE IMPLEMENTATION ─────────────────────
// Runs when Supabase isn't configured (local dev, CI, sandbox). Calls
// itself "demo" in error responses for historical compat; this is not
// the same as the user-facing "Try the demo" button (which was removed
// 2026-05-28).
function demoHandler(action, body, req, res) {
  if (action === "signup") {
    // Task #139 — also rate-limit demo-mode signups so local CI loops
    // can't accidentally exercise an unbounded creation path.
    const rl = require("./_lib/rate_limit.js");
    const ip = rl.getClientIp(req);
    const decision = rl.check(ip, "signup", {
      limit: Number(process.env.BBX_SIGNUP_RATE_LIMIT) || 20,
      windowMs: 60 * 60 * 1000,
    });
    if (!decision.allowed) {
      res.setHeader && res.setHeader("Retry-After", String(decision.retryAfter));
      return res.status(429).json({
        error: decision.error,
        retry_after_seconds: decision.retryAfter,
      });
    }
    const { email, password, role, company_name, app_name } = body;
    if (!email || !password || !role) return res.status(400).json({ error: "Missing email, password, or role" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (!["advertiser", "developer"].includes(role)) return res.status(400).json({ error: "role must be advertiser or developer" });
    const user = demoUpsert(email, role, { company_name, app_name });
    const token = tokenFor(user);
    setSessionCookie(res, token);
    return res.json({
      success: true,
      mode: "demo",
      user: { id: user.id, email: user.email, role: user.role },
      profile: user.profile,
      session: { access_token: token, expires_in: TOKEN_TTL_SEC, token_type: "Bearer" },
    });
  }

  if (action === "login") {
    const { email, password } = body;
    if (!email || !password) return res.status(400).json({ error: "Missing email or password" });
    // In demo mode, any login auto-creates an advertiser if unknown — friction-free for evaluators.
    const id = userIdFromEmail(email);
    let user = DEMO_USERS.get(id);
    if (!user) user = demoUpsert(email, "advertiser");
    const token = tokenFor(user);
    setSessionCookie(res, token);
    return res.json({
      success: true,
      mode: "demo",
      user: { id: user.id, email: user.email, role: user.role },
      profile: user.profile,
      session: { access_token: token, expires_in: TOKEN_TTL_SEC, token_type: "Bearer" },
    });
  }

  // Cross-origin read-only auth check used by benna.ai.
  //   GET /api/auth?action=me_cors with Cookie: bb_session=<jwt>
  // Returns a minimal {email, app_name, role} so benna.ai can render
  // the avatar + name lockup. Never returns sensitive data.
  if (action === "me_cors") {
    const token = readSessionCookie(req);
    if (!token) return res.status(401).json({ error: "Not signed in" });
    const claims = verifyJwt(token);
    if (!claims) return res.status(401).json({ error: "Invalid or expired token" });
    let user = DEMO_USERS.get(claims.sub);
    if (!user) user = demoUpsert(claims.email, claims.role);
    const p = user.profile || {};
    return res.json({
      mode: "demo",
      email:        user.email,
      role:         user.role,
      app_name:     p.app_name || null,
      company_name: p.company_name || null,
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
    // Also clear the bb_session cookie so benna.ai's me_cors check
    // returns 401 on the next page load.
    res.setHeader("Set-Cookie",
      "bb_session=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0");
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

  // Update which placements the publisher has switched off (demo path).
  if (action === "update_placements") {
    const { api_key, disabled_placements } = body;
    if (!api_key || !Array.isArray(disabled_placements)) {
      return res.status(400).json({ error: "Missing api_key or disabled_placements[]" });
    }
    for (const user of DEMO_USERS.values()) {
      if (user.profile?.api_key === api_key) {
        user.profile.disabled_placements = disabled_placements.map(String);
        return res.json({ success: true, mode: "demo", disabled_placements: user.profile.disabled_placements });
      }
    }
    return res.status(404).json({ error: "Developer not found" });
  }

  // Update a user's notification preferences (publisher or advertiser).
  // Demo mode: match by api_key when supplied; otherwise just acknowledge
  // (demo state is in-memory and ephemeral, so persistence isn't critical).
  if (action === "update_notif_prefs") {
    const prefs = body && body.prefs;
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) {
      return res.status(400).json({ error: "prefs must be an object" });
    }
    if (body.api_key) {
      for (const user of DEMO_USERS.values()) {
        if (user.profile && user.profile.api_key === body.api_key) {
          user.profile.notification_prefs = { ...(user.profile.notification_prefs || {}), ...prefs };
          return res.json({ success: true, mode: "demo", notification_prefs: user.profile.notification_prefs });
        }
      }
    }
    return res.json({ success: true, mode: "demo", notification_prefs: prefs });
  }

  // Update a publisher's account-level brand-safety blocklists.
  if (action === "update_brand_safety") {
    const cats = Array.isArray(body && body.blocked_categories) ? body.blocked_categories : null;
    const doms = Array.isArray(body && body.blocked_advertiser_domains) ? body.blocked_advertiser_domains : null;
    if (cats === null && doms === null) {
      return res.status(400).json({ error: "Provide blocked_categories and/or blocked_advertiser_domains arrays" });
    }
    if (body.api_key) {
      for (const user of DEMO_USERS.values()) {
        if (user.profile && user.profile.api_key === body.api_key) {
          if (cats) user.profile.blocked_categories = cats;
          if (doms) user.profile.blocked_advertiser_domains = doms;
          return res.json({
            success: true, mode: "demo",
            blocked_categories: user.profile.blocked_categories || [],
            blocked_advertiser_domains: user.profile.blocked_advertiser_domains || [],
          });
        }
      }
    }
    return res.json({ success: true, mode: "demo", blocked_categories: cats || [], blocked_advertiser_domains: doms || [] });
  }

  if (action === "change_password") {
    return res.status(400).json({ error: "Password change requires a real account — not available in demo mode." });
  }

  if (action === "oauth_sync") {
    // No Supabase configured; OAuth isn't available here.
    return res.status(501).json({ error: "Google sign-in requires Supabase — this deployment isn't configured for OAuth. Use email + password." });
  }

  return res.status(400).json({ error: "Unknown action. Use: signup, login, oauth_sync, me, logout, update_formats, update_placements" });
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

  // The `action === "demo"` quick-start branch was removed 2026-05-28.
  // The dashboards no longer expose a "Try the demo" button, so there's
  // no caller for it — users go through normal signup or OAuth.

  if (action === "signup") {
    // Task #139 — IP-keyed signup rate limit. Supabase already throttles
    // ~30 signUp() calls/hour/IP at the project level; this is a second
    // layer of defense at the application boundary. Limit chosen to be
    // permissive enough that a single household / coffee shop NAT'd
    // behind one IP can comfortably onboard ~20 accounts per hour.
    const rl = require("./_lib/rate_limit.js");
    const ip = rl.getClientIp(req);
    const decision = rl.check(ip, "signup", {
      limit: Number(process.env.BBX_SIGNUP_RATE_LIMIT) || 20,
      windowMs: 60 * 60 * 1000, // 1 hour
      errorMessage:
        "Too many signups from this network. Please wait an hour and try again, or contact support@boostboss.ai if you believe this is in error.",
    });
    if (!decision.allowed) {
      res.setHeader && res.setHeader("Retry-After", String(decision.retryAfter));
      return res.status(429).json({
        error: decision.error,
        retry_after_seconds: decision.retryAfter,
      });
    }
    return signupSupabase(supabaseAdmin, supabaseAnon, body, res);
  }

  if (action === "login") {
    const { email, password, role: wantedRoleRaw } = body;
    if (!email || !password) return res.status(400).json({ error: "Missing email or password" });
    const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
    if (error) {
      // Phase 3A: catch the specific "email not confirmed" error and return
      // a structured response so the signup page can render a "resend
      // confirmation" button instead of a generic error.
      const msg = (error.message || "").toLowerCase();
      if (msg.includes("email not confirmed") || msg.includes("not confirmed") || msg.includes("confirm")) {
        return res.status(403).json({
          error: "Please confirm your email before signing in. Check your inbox for the confirmation link.",
          requires_confirmation: true,
          email,
        });
      }
      return res.status(401).json({ error: error.message });
    }

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
      // Cross-role sign-in path (added 2026-06-14). The auth user exists
      // (their email+password is valid), but they don't have a profile row
      // for the dashboard they just tried to enter. Instead of forcing them
      // back to /signup with terms re-check and a second welcome email, we
      // return a structured response so the signin page can pop an inline
      // questionnaire — they finish onboarding right there and land on the
      // dashboard.
      //
      // The session IS returned so the signin page can immediately call
      // the follow-up complete_role_profile endpoint with the Bearer token.
      // Setting the session cookie too keeps benna.ai in sync.
      setSessionCookie(res, data.session.access_token);
      return res.json({
        success:       true,
        mode:          "supabase",
        needs_profile: wantedRole,                 // 'advertiser' | 'developer'
        user:          { id: data.user.id, email: data.user.email, role: wantedRole },
        session:       { access_token: data.session.access_token, refresh_token: data.session.refresh_token },
      });
    }

    // Set the cross-origin session cookie alongside the existing
    // Bearer token. benna.ai reads this cookie via /api/auth?action=me_cors
    // to know whether to render the avatar lockup or the Sign-up CTA.
    setSessionCookie(res, data.session.access_token);

    return res.json({
      success: true, mode: "supabase",
      user: { id: data.user.id, email: data.user.email, role: wantedRole },
      profile,
      session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token },
    });
  }

  // ── Refresh access token via refresh_token ─────────────────────────
  // Supabase access tokens expire after ~1 hour. Rather than force
  // sign-in every hour, the dashboard's auth-guard catches 401s, posts
  // the refresh_token from saveSession, and gets back a fresh
  // access_token + (rotated) refresh_token. The original request is
  // then retried with the new bearer.
  //
  // Body: { refresh_token: "..." }
  // Public — no Authorization required (the refresh_token IS the credential).
  if (action === "refresh") {
    const refresh_token = (body && body.refresh_token) || "";
    if (!refresh_token) return res.status(400).json({ error: "Missing refresh_token" });
    const { data, error } = await supabaseAnon.auth.refreshSession({ refresh_token });
    if (error || !data || !data.session) {
      // Refresh failed — usually because the refresh_token itself is
      // expired or revoked. Caller should clear local session and
      // bounce the user to /signin.
      return res.status(401).json({ error: error?.message || "Refresh failed", code: "refresh_failed" });
    }
    // Keep the cross-origin cookie in sync so benna.ai notices.
    setSessionCookie(res, data.session.access_token);
    return res.json({
      success: true,
      session: {
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in:    data.session.expires_in,
        token_type:    "Bearer",
      },
      user: data.user ? { id: data.user.id, email: data.user.email } : null,
    });
  }

  // ── Cross-role onboarding: complete the missing profile ──
  // Companion endpoint to the login `needs_profile` branch. The user has
  // already authenticated at the Supabase auth level (their email+password
  // worked). They land on /ads/signin while only having a developer row
  // (or vice versa). The signin page captures the Bearer access_token from
  // the login response and POSTs here with the role-specific fields the
  // questionnaire collected. We insert the missing row, return the full
  // session/profile, and the page redirects to the dashboard.
  //
  // Why this is separate from signup:
  //   • Terms are already accepted from the original signup
  //   • The auth user already exists — Supabase will not fire a second
  //     "Confirm signup" email (we use signInWithPassword identity, not
  //     supabaseAnon.auth.signUp)
  //   • user_metadata.roles[] gets the new role appended so future logins
  //     remember this account is enrolled in both products
  //
  // Body: { role: 'advertiser' | 'developer', company_name?, app_name? }
  // Auth: Authorization: Bearer <access_token from the login response>
  if (action === "complete_role_profile") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "Missing access token. Sign in first." });

    const { role: roleRaw, company_name, app_name, integration_door: doorRaw } = body || {};
    const role = roleRaw === "advertiser" || roleRaw === "developer" ? roleRaw : null;
    if (!role) return res.status(400).json({ error: "Missing or invalid role" });
    // Whitelist the integration door so a misbehaving client can't shove
    // arbitrary strings into the column behind the CHECK constraint.
    // Task #144: aligned with the canonical 4-door taxonomy used by the
    // SDK + /publish/* docs (hyphens, not underscores). Catch-alls
    // "multiple" and "other" come from the primary signup form's "what
    // are you building?" question and are accepted as legitimate signal.
    // Legacy underscored values get rewritten so old clients still work.
    const DOOR_LEGACY_TO_CANONICAL = { js_snippet: "js-snippet", npm_sdk: "npm-sdk", rest: "rest-api", mobile_app: "mobile-app" };
    // Whitelist includes the new 'mobile-app' door key per
    // [[advertiser-pilot-model]]. Migration 30 updates the DB CHECK
    // constraint to match.
    const ALLOWED_DOORS = new Set(["mcp", "js-snippet", "npm-sdk", "rest-api", "mobile-app", "multiple", "other"]);
    const doorCandidate = (typeof doorRaw === "string" && DOOR_LEGACY_TO_CANONICAL[doorRaw]) || doorRaw;
    const integration_door = (role === "developer" && ALLOWED_DOORS.has(doorCandidate)) ? doorCandidate : null;

    const { data: { user }, error: meErr } = await supabaseAnon.auth.getUser(token);
    if (meErr || !user) return res.status(401).json({ error: "Invalid or expired token. Sign in again." });

    const table = role === "advertiser" ? "advertisers" : "developers";

    // Don't double-insert. If the row already exists this user clicked
    // back/forward to a stale modal — surface a clean error.
    const { data: existing } = await supabaseAdmin
      .from(table).select("id").eq("id", user.id).maybeSingle();
    if (existing) {
      const product = role === "advertiser" ? "SuperBoost Ads" : "Lumi SDK";
      return res.status(409).json({ error: `Already enrolled in ${product}. Please sign in normally.` });
    }

    // Insert the new role's profile row. Defaults mirror the original
    // signup path so downstream surfaces (campaign create, earnings) find
    // the columns they expect.
    let inserted = null;
    if (role === "advertiser") {
      const { data, error } = await supabaseAdmin
        .from("advertisers")
        .insert({
          id:           user.id,
          email:        user.email,
          company_name: company_name || (user.email || "").split("@")[0],
          balance:      0,
        })
        .select("*").maybeSingle();
      if (error) return res.status(500).json({ error: "Could not create advertiser profile: " + error.message });
      inserted = data;
    } else {
      const apiKey = makeApiKey("dev", user.id);
      const { data, error } = await supabaseAdmin
        .from("developers")
        .insert({
          id:                user.id,
          email:             user.email,
          app_name:          app_name || (user.email || "").split("@")[0],
          api_key:           apiKey,
          integration_door:  integration_door,  // nullable; whitelisted above
        })
        .select("*").maybeSingle();
      if (error) return res.status(500).json({ error: "Could not create developer profile: " + error.message });
      inserted = data;

      // Auto-register the per-door placement set so the publisher's SDK
      // installs immediately have inventory to match against. Fire-and-
      // forget — the RPC is idempotent and silently no-ops for doors
      // without a template (rest-api / multiple / other). See migration
      // 30_placement_kind_and_autoreg.sql + [[advertiser-pilot-model]].
      if (integration_door) {
        supabaseAdmin.rpc("auto_register_placements_for_developer", {
          p_developer_id: data.id,
          p_door:         integration_door,
        }).then(
          () => { /* success — placements created or already there */ },
          (err) => { console.warn("[auth] auto_register_placements failed:", err && err.message); }
        );
      }
    }

    // Merge the new role into user_metadata.roles[] so the next login on
    // either side knows this account spans both products.
    try {
      const existingMeta = user.user_metadata || {};
      const existingRoles = existingMeta.roles || (existingMeta.role ? [existingMeta.role] : []);
      const mergedRoles = Array.from(new Set([].concat(existingRoles, [role])));
      const newMeta = Object.assign({}, existingMeta, { role, roles: mergedRoles });
      if (role === "advertiser" && company_name) newMeta.company_name = company_name;
      if (role === "developer"  && app_name)     newMeta.app_name     = app_name;
      await supabaseAdmin.auth.admin.updateUserById(user.id, { user_metadata: newMeta });
    } catch (e) {
      console.warn("[Auth] complete_role_profile: user_metadata merge failed:", e.message);
    }

    return res.json({
      success: true,
      mode:    "supabase",
      user:    { id: user.id, email: user.email, role },
      profile: inserted,
    });
  }

  // Cross-origin read-only auth check used by benna.ai.
  // Same shape as the demo branch's me_cors above.
  if (action === "me_cors") {
    const token = readSessionCookie(req);
    if (!token) return res.status(401).json({ error: "Not signed in" });
    const { data: { user }, error } = await supabaseAnon.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid or expired token" });
    // Pull the matching profile for whichever role the user last signed
    // in with. We don't know the route they're coming from on benna.ai,
    // so fall back to user_metadata.role.
    const role = user.user_metadata?.role || "advertiser";
    let appName = null, companyName = null;
    if (role === "advertiser") {
      const { data: adv } = await supabaseAdmin
        .from("advertisers")
        .select("company_name")
        .eq("id", user.id)
        .maybeSingle();
      companyName = adv && adv.company_name;
    } else if (role === "developer") {
      const { data: dev } = await supabaseAdmin
        .from("developers")
        .select("app_name")
        .eq("id", user.id)
        .maybeSingle();
      appName = dev && dev.app_name;
    }
    return res.json({
      mode: "supabase",
      email:        user.email,
      role,
      app_name:     appName,
      company_name: companyName,
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
    // `wasNewProfile` triggers the branded welcome email further down.
    let profile = null;
    let wasNewProfile = false;
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
        wasNewProfile = true;
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
        wasNewProfile = true;
      }
    }

    // Phase 4: send the branded welcome email on FIRST successful sign-in
    // for this role. Fire-and-forget — don't block the response on email
    // delivery. If `wasNewProfile` is false (returning user, or user adding
    // a second product to an existing account), we skip the welcome.
    if (wasNewProfile && user.email) {
      try {
        const { sendWelcome } = require("./_lib/emails/send");
        const firstName = (user.user_metadata?.full_name || user.user_metadata?.name || "")
          .toString().split(" ")[0] || "";
        sendWelcome({ to: user.email, role, firstName })
          .catch((e) => console.error("[Auth oauth_sync] sendWelcome threw:", e.message));
      } catch (e) {
        console.warn("[Auth oauth_sync] welcome email skipped:", e.message);
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

    // Set the cross-origin session cookie so benna.ai can detect the
    // logged-in user. Google OAuth is the most common sign-in path, so
    // this branch absolutely has to set the cookie — missing this was
    // the bug that left benna.ai showing Sign-up after every OAuth
    // sign-in.
    setSessionCookie(res, token);

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
    // Clear the cross-origin session cookie so benna.ai notices.
    res.setHeader("Set-Cookie",
      "bb_session=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0");
    return res.json({ success: true, mode: "supabase" });
  }

  // ── Phase 3A: Resend the email-confirmation message ──
  // Called from either the /check-email page ("Didn't get the email?") or
  // from the signup page when a login fails with requires_confirmation.
  if (action === "resend_confirmation") {
    const { email, role: roleRaw } = body;
    if (!email) return res.status(400).json({ error: "Missing email" });
    const role = roleRaw === "developer" ? "developer" : "advertiser";
    const { error } = await supabaseAnon.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: confirmRedirectFor(role) },
    });
    if (error) {
      // Don't leak whether the email exists — return a generic success
      // even on "user not found" to avoid email enumeration.
      console.warn("[Auth] resend_confirmation error:", error.message);
    }
    return res.json({ success: true });
  }

  // ── Phase 3B: Request password reset email ──
  // Triggered by the /forgot-password page. Email contains a link to
  // /ads/reset-password (or /publish/reset-password) where the user lands
  // with the recovery access_token in the URL hash. The reset-password
  // page uses that token to authenticate, then calls action=update_password
  // to set the new value.
  //
  // We always return success even if the email doesn't exist, to avoid
  // letting attackers enumerate registered emails.
  if (action === "request_password_reset") {
    const { email, role: roleRaw } = body;
    if (!email) return res.status(400).json({ error: "Missing email" });
    const role = roleRaw === "developer" ? "developer" : "advertiser";
    const { error } = await supabaseAnon.auth.resetPasswordForEmail(email, {
      redirectTo: resetRedirectFor(role),
    });
    if (error) {
      console.warn("[Auth] request_password_reset error:", error.message);
    }
    return res.json({ success: true });
  }

  // ── Phase 3B: Update password using a recovery-flow access_token ──
  // The /reset-password page extracts the access_token from the URL hash
  // (set by Supabase after verifying the recovery link), then POSTs it
  // here with the new password. We use the user-scoped Supabase client
  // (not admin) so that the access_token is what authorizes the update,
  // not our service role key — that way the token actually has to be
  // valid + non-expired + of recovery type.
  if (action === "update_password") {
    const { access_token, password } = body;
    if (!access_token || !password) {
      return res.status(400).json({ error: "Missing access_token or password" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    const createClient = loadSupabase();
    if (!createClient) return res.status(500).json({ error: "Supabase client unavailable" });
    // User-scoped client — uses the recovery access_token as the bearer.
    const supabaseUser = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${access_token}` } },
    });
    const { error } = await supabaseUser.auth.updateUser({ password });
    if (error) {
      return res.status(400).json({
        error: error.message || "Could not update password. The reset link may have expired.",
      });
    }
    return res.json({ success: true });
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

  // Update which placements the publisher has switched off — db/20.
  if (action === "update_placements") {
    const { api_key, disabled_placements } = body;
    if (!api_key || !Array.isArray(disabled_placements)) {
      return res.status(400).json({ error: "Missing api_key or disabled_placements[]" });
    }
    const clean = [...new Set(disabled_placements.map(String).filter(Boolean))];
    const { data: dev, error: lookupErr } = await supabaseAdmin
      .from("developers").select("id").eq("api_key", api_key).single();
    if (lookupErr || !dev) return res.status(404).json({ error: "Developer not found" });
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("developers")
      .update({ disabled_placements: clean })
      .eq("id", dev.id)
      .select("disabled_placements")
      .single();
    if (updateErr) return res.status(500).json({ error: updateErr.message });
    return res.json({ success: true, mode: "supabase", disabled_placements: updated.disabled_placements });
  }

  // Update notification preferences — token-verified, works for both
  // publisher (developers) and advertiser (advertisers) accounts.
  if (action === "update_notif_prefs") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "No token" });
    const { data: { user }, error: authErr } = await supabaseAnon.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Invalid token" });
    const prefs = body && body.prefs;
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) {
      return res.status(400).json({ error: "prefs must be an object" });
    }
    const table = (body && body.role === "advertiser") ? "advertisers" : "developers";
    const { data, error: upErr } = await supabaseAdmin
      .from(table)
      .update({ notification_prefs: prefs })
      .eq("id", user.id)
      .select("notification_prefs")
      .single();
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.json({ success: true, mode: "supabase", notification_prefs: (data && data.notification_prefs) || prefs });
  }

  // Update a publisher's account-level brand-safety blocklists — token-verified.
  if (action === "update_brand_safety") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "No token" });
    const { data: { user }, error: authErr } = await supabaseAnon.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Invalid token" });
    const updates = {};
    if (Array.isArray(body && body.blocked_categories)) {
      updates.blocked_categories = body.blocked_categories
        .filter((s) => typeof s === "string" && s.length <= 32).slice(0, 100);
    }
    if (Array.isArray(body && body.blocked_advertiser_domains)) {
      updates.blocked_advertiser_domains = body.blocked_advertiser_domains
        .filter((s) => typeof s === "string")
        .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
        .filter(Boolean).slice(0, 200);
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "Provide blocked_categories and/or blocked_advertiser_domains arrays" });
    }
    const { data, error: upErr } = await supabaseAdmin
      .from("developers").update(updates).eq("id", user.id)
      .select("blocked_categories, blocked_advertiser_domains").single();
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.json({
      success: true, mode: "supabase",
      blocked_categories: (data && data.blocked_categories) || [],
      blocked_advertiser_domains: (data && data.blocked_advertiser_domains) || [],
    });
  }

  // Change account password — re-verifies the current password, then sets
  // the new one via the Supabase admin API. Role-agnostic (auth is shared).
  if (action === "change_password") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "No token" });
    const { data: { user }, error: authErr } = await supabaseAnon.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Invalid token" });
    const currentPassword = body && body.current_password;
    const newPassword = body && body.new_password;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "current_password and new_password are required" });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }
    // Re-verify the current password before allowing the change.
    const { error: signInErr } = await supabaseAnon.auth.signInWithPassword({
      email: user.email, password: currentPassword,
    });
    if (signInErr) return res.status(401).json({ error: "Current password is incorrect" });
    const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password: newPassword });
    if (updErr) return res.status(500).json({ error: updErr.message });
    return res.json({ success: true, mode: "supabase" });
  }

  // ── MFA (TOTP) ──────────────────────────────────────────────────────────
  // Four actions plus a step-up verify used by cashout / bank-change flows:
  //
  //   mfa_status        → { enrolled, enrolled_at? }
  //   mfa_enroll_init   → server generates secret + otpauth URI; the secret
  //                       round-trips back on enroll_verify (stateless pattern,
  //                       no pending_enrollments table needed)
  //   mfa_enroll_verify → { secret_b32, code } — verifies, then writes user_mfa
  //   mfa_disable       → { code } — verifies current factor, then deletes
  //   verify_totp       → { code } — step-up auth for cashout / bank changes
  //                       Sets user_mfa.last_step_up_at as an audit trail.
  if (action === "mfa_status" || action === "mfa_enroll_init"
      || action === "mfa_enroll_verify" || action === "mfa_disable"
      || action === "verify_totp") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "No token" });
    const { data: { user }, error: authErr } = await supabaseAnon.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Invalid token" });

    const totp = require("./_lib/totp.js");

    if (action === "mfa_status") {
      const { data, error } = await supabaseAdmin
        .from("user_mfa")
        .select("enrolled_at, last_used_at")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({
        enrolled: !!data,
        enrolled_at: data ? data.enrolled_at : null,
        last_used_at: data ? data.last_used_at : null,
      });
    }

    if (action === "mfa_enroll_init") {
      // Check the user isn't already enrolled. Disable-then-re-enroll is
      // the supported path; we don't allow silent overwrite.
      const { data: existing } = await supabaseAdmin
        .from("user_mfa").select("user_id").eq("user_id", user.id).maybeSingle();
      if (existing) {
        return res.status(409).json({ error: "Two-factor is already enabled. Disable it first to re-enroll." });
      }
      const secret = totp.generateBase32Secret();
      const uri = totp.buildOtpauthURI({ secret, accountName: user.email || "publisher" });
      return res.json({ secret_b32: secret, qr_uri: uri });
    }

    if (action === "mfa_enroll_verify") {
      const { secret_b32, code } = body || {};
      if (!secret_b32 || !code) {
        return res.status(400).json({ error: "secret_b32 and code are required" });
      }
      if (!totp.verifyCode(secret_b32, code, 1)) {
        return res.status(401).json({ error: "That code doesn't match. Make sure you're using the latest one shown in your authenticator app." });
      }
      // Idempotent-ish upsert: if a row somehow exists, replace it. We
      // already 409 in init, but a race during enrollment shouldn't 500.
      const { error } = await supabaseAdmin
        .from("user_mfa")
        .upsert({
          user_id: user.id,
          totp_secret: secret_b32,
          friendly_name: "Authenticator",
          enrolled_at: new Date().toISOString(),
          last_used_at: new Date().toISOString(),
          failed_attempts: 0,
        }, { onConflict: "user_id" });
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, enrolled_at: new Date().toISOString() });
    }

    if (action === "mfa_disable") {
      const { code } = body || {};
      if (!code) return res.status(400).json({ error: "code is required" });
      const { data: row, error: readErr } = await supabaseAdmin
        .from("user_mfa")
        .select("totp_secret, failed_attempts")
        .eq("user_id", user.id)
        .maybeSingle();
      if (readErr) return res.status(500).json({ error: readErr.message });
      if (!row) return res.status(404).json({ error: "Two-factor is not currently enabled on this account." });
      if ((row.failed_attempts || 0) >= 10) {
        return res.status(429).json({ error: "Too many failed attempts. Email support@boostboss.ai to recover access." });
      }
      if (!totp.verifyCode(row.totp_secret, code, 1)) {
        await supabaseAdmin
          .from("user_mfa")
          .update({ failed_attempts: (row.failed_attempts || 0) + 1 })
          .eq("user_id", user.id);
        return res.status(401).json({ error: "That code doesn't match. Try the latest one from your authenticator app." });
      }
      const { error: delErr } = await supabaseAdmin
        .from("user_mfa").delete().eq("user_id", user.id);
      if (delErr) return res.status(500).json({ error: delErr.message });
      return res.json({ success: true });
    }

    if (action === "verify_totp") {
      // Step-up auth: used by cashout and bank-detail-change flows. Marks
      // last_step_up_at as an audit trail; downstream caller checks recency.
      const { code } = body || {};
      if (!code) return res.status(400).json({ error: "code is required" });
      const { data: row, error: readErr } = await supabaseAdmin
        .from("user_mfa")
        .select("totp_secret, failed_attempts")
        .eq("user_id", user.id)
        .maybeSingle();
      if (readErr) return res.status(500).json({ error: readErr.message });
      if (!row) return res.status(404).json({ error: "Two-factor is not enabled. Enable it in Settings to continue." });
      if ((row.failed_attempts || 0) >= 10) {
        return res.status(429).json({ error: "Too many failed attempts. Email support@boostboss.ai to recover access." });
      }
      if (!totp.verifyCode(row.totp_secret, code, 1)) {
        await supabaseAdmin
          .from("user_mfa")
          .update({ failed_attempts: (row.failed_attempts || 0) + 1 })
          .eq("user_id", user.id);
        return res.status(401).json({ error: "That code doesn't match. Try the latest one from your authenticator app." });
      }
      const now = new Date().toISOString();
      await supabaseAdmin
        .from("user_mfa")
        .update({ last_used_at: now, last_step_up_at: now, failed_attempts: 0 })
        .eq("user_id", user.id);
      return res.json({ success: true, verified_at: now });
    }
  }

  // ── Onboarding questionnaire ───────────────────────────────────────────
  // Required for every new signup before they can interact with the
  // dashboard. The frontend gates the dashboard with a modal that posts
  // here. Allowed values match the CHECK constraints in
  // launch-kit/MIGRATION-onboarding-questionnaire.sql; we don't validate
  // exhaustively here because the DB will reject anything off-list.
  //
  // Role-specific shape:
  //   advertiser → { industry, product_type, digital_dau_range?, annual_revenue_range }
  //   developer  → { ai_app_category, surface_type, daily_users_range, monetization_model }
  //
  // Sets onboarding_completed_at as the gate signal — frontend reads this
  // from the `me` response on every dashboard load and decides whether to
  // show the modal.
  if (action === "save_onboarding") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "No token" });
    const { data: { user }, error: authErr } = await supabaseAnon.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Invalid token" });

    const role = (body && body.role) === "developer" ? "developer" : "advertiser";
    const nowIso = new Date().toISOString();

    if (role === "advertiser") {
      const {
        industry, product_type, digital_dau_range, annual_revenue_range,
      } = body || {};

      // Required: industry + product_type + annual_revenue_range. DAU is
      // only required when product_type='digital' — otherwise it's null.
      if (!industry || !String(industry).trim()) {
        return res.status(400).json({ error: "Industry is required" });
      }
      if (!product_type) {
        return res.status(400).json({ error: "Product type is required" });
      }
      if (!annual_revenue_range) {
        return res.status(400).json({ error: "Annual revenue range is required" });
      }
      const dauForRow = product_type === "digital" ? (digital_dau_range || null) : null;
      if (product_type === "digital" && !dauForRow) {
        return res.status(400).json({ error: "Daily active users range is required for digital products" });
      }

      const row = {
        industry:                 String(industry).trim().slice(0, 80),
        product_type:             String(product_type),
        digital_dau_range:        dauForRow,
        annual_revenue_range:     String(annual_revenue_range),
        onboarding_completed_at:  nowIso,
        updated_at:               nowIso,
      };
      const { error: upErr } = await supabaseAdmin
        .from("advertisers")
        .update(row)
        .eq("id", user.id);
      if (upErr) return res.status(500).json({ error: upErr.message });
      return res.json({ success: true, role, saved_at: nowIso });
    }

    // developer (publisher) path
    const {
      ai_app_category, surface_type, daily_users_range, monetization_model,
    } = body || {};

    if (!ai_app_category) return res.status(400).json({ error: "AI app category is required" });
    if (!surface_type)    return res.status(400).json({ error: "Surface type is required" });
    if (!daily_users_range) return res.status(400).json({ error: "Daily users range is required" });
    if (!monetization_model) return res.status(400).json({ error: "Monetization model is required" });

    const row = {
      ai_app_category:          String(ai_app_category),
      surface_type:             String(surface_type),
      daily_users_range:        String(daily_users_range),
      monetization_model:       String(monetization_model),
      onboarding_completed_at:  nowIso,
      updated_at:               nowIso,
    };
    const { error: upErr } = await supabaseAdmin
      .from("developers")
      .update(row)
      .eq("id", user.id);
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.json({ success: true, role, saved_at: nowIso });
  }

  // ── Admin: list/search users with performance summary ─────────────────
  // Powers the /admin Users panel. Returns advertiser + publisher rows
  // with their onboarding answers + lightweight performance metrics so
  // the admin can spot active accounts, big spenders, top earners, and
  // anyone stuck in onboarding without opening Supabase directly.
  //
  // Auth: BBX_ADMIN_KEY or ADMIN_TOKEN bearer.
  //
  // Query params (all optional, via JSON body or query string):
  //   role       — "advertiser" | "developer" | "all" (default: "all")
  //   q          — search string; matched against email + company/app name
  //   limit      — page size, default 50, max 200
  //   offset     — pagination offset
  //
  // Response shape:
  //   { users: [{id, role, email, name, balance, signup_date,
  //              onboarding_completed, profile_summary, performance}], total }
  if (action === "admin_list_users") {
    const authHeader = req.headers && req.headers.authorization;
    const adminToken = authHeader && authHeader.replace(/^Bearer\s+/i, "");
    const staticKeys = [process.env.BBX_ADMIN_KEY, process.env.ADMIN_TOKEN].filter(Boolean);
    if (!adminToken || !staticKeys.includes(adminToken)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    const params = Object.assign({}, req.query || {}, body || {});
    const role = (params.role || "all").toString();
    const q = (params.q || "").toString().trim().toLowerCase();
    const limit = Math.min(parseInt(params.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(params.offset, 10) || 0, 0);

    // Helper — build the per-table query with optional fuzzy search.
    async function fetchTable(table, nameField) {
      let query = supabaseAdmin
        .from(table)
        .select(`id, email, ${nameField}, balance, created_at, onboarding_completed_at, industry, product_type, digital_dau_range, annual_revenue_range, ai_app_category, surface_type, daily_users_range, monetization_model`, { count: "exact" })
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
      if (q) {
        // Match either email or name field. Supabase .or() syntax.
        const safe = q.replace(/[%,]/g, "");
        query = query.or(`email.ilike.%${safe}%,${nameField}.ilike.%${safe}%`);
      }
      const { data, count, error } = await query;
      if (error) throw error;
      return { rows: data || [], count: count || 0 };
    }

    try {
      const wantAdvertisers = (role === "all" || role === "advertiser");
      const wantPublishers  = (role === "all" || role === "developer");

      const [advResult, devResult] = await Promise.all([
        wantAdvertisers ? fetchTable("advertisers", "company_name") : Promise.resolve({ rows: [], count: 0 }),
        wantPublishers  ? fetchTable("developers",  "app_name")     : Promise.resolve({ rows: [], count: 0 }),
      ]);

      // Compute performance per row. Keep cheap: aggregate from campaigns
      // (advertisers). Publishers earn credits only (no cash payouts), so
      // their performance is just the credit balance already on the row.
      const advIds = advResult.rows.map((r) => r.id);

      let spendByAdv = new Map();
      let campaignsByAdv = new Map();
      if (advIds.length > 0) {
        try {
          const { data: campaigns } = await supabaseAdmin
            .from("campaigns")
            .select("advertiser_id, spent")
            .in("advertiser_id", advIds);
          (campaigns || []).forEach((c) => {
            const adv = c.advertiser_id;
            spendByAdv.set(adv, (spendByAdv.get(adv) || 0) + Number(c.spent || 0));
            campaignsByAdv.set(adv, (campaignsByAdv.get(adv) || 0) + 1);
          });
        } catch (_) { /* column may not exist on every env — best effort */ }
      }

      const users = [];
      for (const r of advResult.rows) {
        users.push({
          id: r.id,
          role: "advertiser",
          email: r.email,
          name: r.company_name || null,
          balance: Number(r.balance) || 0,
          signup_date: r.created_at,
          onboarding_completed: !!r.onboarding_completed_at,
          profile_summary: {
            industry:             r.industry             || null,
            product_type:         r.product_type         || null,
            digital_dau_range:    r.digital_dau_range    || null,
            annual_revenue_range: r.annual_revenue_range || null,
          },
          performance: {
            lifetime_spend_usd: spendByAdv.get(r.id) || 0,
            campaign_count:     campaignsByAdv.get(r.id) || 0,
          },
        });
      }
      for (const r of devResult.rows) {
        users.push({
          id: r.id,
          role: "developer",
          email: r.email,
          name: r.app_name || null,
          balance: Number(r.balance) || 0,
          signup_date: r.created_at,
          onboarding_completed: !!r.onboarding_completed_at,
          profile_summary: {
            ai_app_category:    r.ai_app_category    || null,
            surface_type:       r.surface_type       || null,
            daily_users_range:  r.daily_users_range  || null,
            monetization_model: r.monetization_model || null,
          },
          performance: {
            credit_balance: Number(r.balance) || 0,
          },
        });
      }

      // Sort the combined set by signup date desc so newest signups
      // surface first regardless of role.
      users.sort((a, b) => {
        const da = a.signup_date ? Date.parse(a.signup_date) : 0;
        const db = b.signup_date ? Date.parse(b.signup_date) : 0;
        return db - da;
      });

      return res.json({
        users,
        total: advResult.count + devResult.count,
        counts: { advertisers: advResult.count, developers: devResult.count },
      });
    } catch (e) {
      console.error("[Admin] admin_list_users failed:", e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: "Unknown action. Use: signup, login, oauth_sync, complete_role_profile, refresh, me, me_cors, logout, resend_confirmation, request_password_reset, update_password, update_formats, update_placements, update_notif_prefs, update_brand_safety, change_password, mfa_status, mfa_enroll_init, mfa_enroll_verify, mfa_disable, verify_totp, save_onboarding, admin_list_users" });
}

// ── helper: build the email confirmation redirect URL for a given role ──
// Email links in the confirmation email land here after Supabase verifies
// the token. /ads/confirm vs /publish/confirm so the user sees the right
// product branding and lands at the right dashboard afterward.
function confirmRedirectFor(role) {
  const base = process.env.PUBLIC_BASE || "https://boostboss.ai";
  if (role === "developer") return `${base}/publish/confirm`;
  return `${base}/ads/confirm`;
}
function resetRedirectFor(role) {
  const base = process.env.PUBLIC_BASE || "https://boostboss.ai";
  if (role === "developer") return `${base}/publish/reset-password`;
  return `${base}/ads/reset-password`;
}

async function signupSupabase(supabaseAdmin, supabaseAnon, body, res) {
  const { email, password, role, company_name, app_name, integration_door: doorRaw } = body;
  if (!email || !password || !role) return res.status(400).json({ error: "Missing email, password, or role" });
  if (role !== "advertiser" && role !== "developer") {
    return res.status(400).json({ error: "Invalid role" });
  }
  // Whitelist integration_door before it touches the DB CHECK constraint.
  // Task #144: canonical hyphenated 4-door taxonomy + "multiple"/"other"
  // catch-alls. Legacy underscored values rewritten for back-compat.
  const DOOR_LEGACY_TO_CANONICAL = { js_snippet: "js-snippet", npm_sdk: "npm-sdk", rest: "rest-api", mobile_app: "mobile-app" };
  // 'mobile-app' added per [[advertiser-pilot-model]]. Migration 30
  // updates the DB CHECK constraint to match this whitelist.
  const ALLOWED_DOORS = new Set(["mcp", "js-snippet", "npm-sdk", "rest-api", "mobile-app", "multiple", "other"]);
  const doorCandidate = (typeof doorRaw === "string" && DOOR_LEGACY_TO_CANONICAL[doorRaw]) || doorRaw;
  const integration_door = (role === "developer" && ALLOWED_DOORS.has(doorCandidate)) ? doorCandidate : null;

  // Phase 3A change (2026-06-10): replaced the previous
  // `supabaseAdmin.auth.admin.createUser({ email_confirm: true })` bypass
  // with real email confirmation. Two reasons:
  //   1. Compliance — an ad network handling money shouldn't let users
  //      register with email addresses they don't own. Auto-confirm meant
  //      spammers could register under any address.
  //   2. Custom-domain branding (Phase 2) — the confirmation email link
  //      uses auth.boostboss.ai now, which only matters if confirmation
  //      emails actually exist.
  //
  // New flow:
  //   - supabaseAnon.auth.signUp() creates the user with email_confirmed=false
  //     and sends the Supabase "Confirm signup" email
  //   - Profile row is still inserted at signup time so it's ready the moment
  //     the user confirms (no race conditions, no webhook setup needed)
  //   - We return { requires_confirmation: true } instead of a session,
  //     so the signup page redirects to /ads/check-email (or /publish/check-email)
  //     instead of straight to the dashboard
  //   - Login is then gated on email_confirmed_at being non-null
  //
  // IMPORTANT — Supabase project setting: this requires "Confirm email" to
  // be enabled in Supabase Dashboard → Authentication → Sign In / Providers
  // → Email → Confirm email. If that's off, signUp returns a session and
  // we'd be back to the bypass.

  const initialMeta = { role };
  if (role === "advertiser" && company_name) initialMeta.company_name = company_name;
  if (role === "developer"  && app_name)     initialMeta.app_name     = app_name;

  // signUp may return null user (if Supabase rejects), or a user with
  // session=null (if email confirmation is required). Both are fine —
  // we don't return a session at this stage either way.
  const { data: signUpData, error: signUpErr } = await supabaseAnon.auth.signUp({
    email,
    password,
    options: {
      data: initialMeta,
      emailRedirectTo: confirmRedirectFor(role),
    },
  });

  let userId = null;
  let existingMeta = {};
  let isExistingUser = false;

  if (signUpErr) {
    // User already exists OR password doesn't meet Supabase requirements.
    // Try signInWithPassword to see if it's the "already registered" case
    // where we should attach a new role to an existing user.
    const { data: siData, error: siErr } = await supabaseAnon.auth.signInWithPassword({ email, password });
    if (siErr || !siData.user) {
      // Most likely: weak password, invalid email format, or rate limit.
      return res.status(400).json({
        error: signUpErr.message || "Could not create account. Please check your email and password.",
      });
    }
    // Existing user, correct password. Could be:
    //   - Adding a second product (advertiser already, now signing up as publisher)
    //   - Re-running signup after confirming a different product
    userId = siData.user.id;
    existingMeta = siData.user.user_metadata || {};
    isExistingUser = true;

    // Refuse if this role's profile already exists — they should sign in instead.
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
    // Supabase signUp() does NOT throw when the email already exists — it
    // returns a "fake user" with identities=[] to prevent email enumeration
    // attacks. We have to detect this case ourselves, otherwise an existing
    // user re-submitting the signup form silently falls through this branch
    // and the page just spins with no feedback (Task #151, fixed 2026-06-19).
    //
    // Per Supabase docs:
    //   https://supabase.com/docs/reference/javascript/auth-signup
    // An empty identities array is the signal that the email is already
    // registered. We reroute into the same "already registered" check the
    // signUpErr branch uses.
    const identities = (signUpData && signUpData.user && signUpData.user.identities) || [];
    if (signUpData && signUpData.user && identities.length === 0) {
      // Existing-but-unconfirmed user OR existing-and-confirmed user.
      // Try signInWithPassword to see if this is the "right password but
      // already registered" case (where they probably meant to sign in).
      const { data: siData } = await supabaseAnon.auth.signInWithPassword({ email, password });
      if (siData && siData.user) {
        userId = siData.user.id;
        existingMeta = siData.user.user_metadata || {};
        isExistingUser = true;

        // Refuse if this role's profile already exists — they should sign in.
        const table = role === "advertiser" ? "advertisers" : "developers";
        const { data: existingProfile } = await supabaseAdmin
          .from(table).select("id").eq("id", userId).maybeSingle();
        if (existingProfile) {
          const product = role === "advertiser" ? "SuperBoost Ads" : "Lumi SDK";
          return res.status(400).json({
            error:        "This email is already registered for " + product + ". Please sign in instead.",
            already_registered: true,
          });
        }
        // Existing user but no profile for this role — fall through to the
        // cross-role attachment path (intended behavior, same as signUpErr
        // branch).
      } else {
        // Existing user but wrong password (or unconfirmed). We can't safely
        // create a new account on top of theirs, but we also don't want to
        // confirm the email exists by saying "wrong password." Tell the user
        // generically and route them to sign in, where they can recover.
        return res.status(400).json({
          error:        "This email may already be registered. Please sign in or use the password reset link.",
          already_registered: true,
        });
      }
    } else {
      userId = signUpData.user?.id;
    }
  }

  if (!userId) {
    return res.status(500).json({ error: "Account created but no user ID returned. Please contact support." });
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

  // Insert the missing profile row for this role. We do this even before
  // confirmation so it's ready the moment they click the email link.
  if (role === "advertiser") {
    // Cold-start: grant a small, bounded free starter credit so a new advertiser
    // can launch a (calibration) campaign immediately. Exposure is bounded to this
    // amount; Phase 4 (advertiser calibration) gates it to free calibration inventory.
    const STARTER_CREDIT = Number(process.env.BBX_STARTER_CREDIT_USD) || 25;
    const { error } = await supabaseAdmin.from("advertisers").insert({
      id: userId, email, company_name: company_name || email.split("@")[0], balance: STARTER_CREDIT,
    });
    if (error) console.error("[Auth] Advertiser insert error:", error.message);
    // Record the free starter grant in the existing transactions ledger (type='grant').
    // Fire-and-forget + non-fatal — signup must never break on it.
    if (!error) {
      supabaseAdmin.from("transactions").insert({
        advertiser_id: userId, type: "grant", amount: STARTER_CREDIT,
        description: "Free starter credit", provider: "boostboss", status: "completed",
      }).then(({ error: txErr }) => {
        if (txErr) console.error("[Auth] starter-credit transaction insert failed:", txErr.message);
      });
    }
  } else {
    const apiKey = makeApiKey("dev", userId);
    const { error } = await supabaseAdmin.from("developers").insert({
      id: userId, email, app_name: app_name || "My AI App",
      api_key: apiKey, status: "active",
      calibration_status: "calibrating",  // cold-start: prove real traffic before monetizing (db/29)
      integration_door: integration_door,  // nullable; whitelisted above
    });
    if (error) console.error("[Auth] Developer insert error:", error.message);

    // Auto-register the per-door placement set so SDK ad requests
    // immediately match real inventory. Idempotent + fire-and-forget.
    // See migration 30 + [[advertiser-pilot-model]].
    if (!error && integration_door) {
      supabaseAdmin.rpc("auto_register_placements_for_developer", {
        p_developer_id: userId,
        p_door:         integration_door,
      }).then(
        () => { /* placements created or already there */ },
        (err) => { console.warn("[Auth] auto_register_placements failed:", err && err.message); }
      );
    }
  }

  // Existing users (adding a second product) who are ALREADY confirmed
  // can sign in immediately for the new product — they've already proven
  // they own the email. Brand-new users must confirm first.
  if (isExistingUser) {
    const { data: signInData, error: signInErr } = await supabaseAnon.auth.signInWithPassword({ email, password });
    let profile;
    if (role === "advertiser") {
      profile = { company_name: company_name || email.split("@")[0], balance: 0 };
    } else {
      const apiKey = makeApiKey("dev", userId);
      profile = { app_name: app_name || "My AI App", api_key: apiKey };
    }
    if (!signInErr && signInData && signInData.session) {
      setSessionCookie(res, signInData.session.access_token);
    }
    return res.json({
      success: true, mode: "supabase", requires_confirmation: false,
      user: { id: userId, email, role },
      profile,
      session: signInErr ? null : {
        access_token: signInData.session.access_token,
        refresh_token: signInData.session.refresh_token,
      },
    });
  }

  // Brand-new signup — redirect to check-email page, no session yet.
  return res.json({
    success: true, mode: "supabase", requires_confirmation: true,
    user: { id: userId, email, role },
  });
}

// ── exports for testing ─────────────────────────────────────────────
module.exports.signJwt = signJwt;
module.exports.verifyJwt = verifyJwt;
module.exports.userIdFromEmail = userIdFromEmail;
module.exports.HAS_SUPABASE = HAS_SUPABASE;
