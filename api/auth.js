const { createClient } = require("@supabase/supabase-js");

/**
 * Boost Boss — Auth API
 * POST /api/auth?action=signup
 * POST /api/auth?action=login
 * POST /api/auth?action=me  (with Authorization header)
 */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const action = req.query.action || req.body.action;

    // ── SIGNUP ──
    if (action === "signup") {
      const { email, password, role, company_name, app_name } = req.body;

      if (!email || !password || !role) {
        return res.status(400).json({ error: "Missing email, password, or role (advertiser|developer)" });
      }

      // Create Supabase Auth user
      const { data: authData, error: authErr } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { role, company_name, app_name } },
      });

      if (authErr) return res.status(400).json({ error: authErr.message });

      const userId = authData.user?.id;

      // Create profile record
      if (role === "advertiser") {
        const { error } = await supabase.from("advertisers").insert({
          id: userId,
          email,
          company_name: company_name || email.split("@")[0],
          balance: 0,
        });
        if (error) console.error("[Auth] Advertiser insert error:", error.message);
      } else if (role === "developer") {
        const { error } = await supabase.from("developers").insert({
          id: userId,
          email,
          app_name: app_name || "My AI App",
        });
        if (error) console.error("[Auth] Developer insert error:", error.message);
      }

      return res.json({
        success: true,
        user: { id: userId, email, role },
        session: authData.session,
      });
    }

    // ── LOGIN ──
    if (action === "login") {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: "Missing email or password" });
      }

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return res.status(401).json({ error: error.message });

      // Determine role
      const role = data.user?.user_metadata?.role || "unknown";
      let profile = null;

      if (role === "advertiser") {
        const { data: adv } = await supabase.from("advertisers").select("*").eq("id", data.user.id).single();
        profile = adv;
      } else if (role === "developer") {
        const { data: dev } = await supabase.from("developers").select("*").eq("id", data.user.id).single();
        profile = dev;
      }

      return res.json({
        success: true,
        user: { id: data.user.id, email: data.user.email, role },
        profile,
        session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token },
      });
    }

    // ── ME (get current user profile) ──
    if (action === "me") {
      const token = (req.headers.authorization || "").replace("Bearer ", "");
      if (!token) return res.status(401).json({ error: "No token" });

      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) return res.status(401).json({ error: "Invalid token" });

      const role = user.user_metadata?.role || "unknown";
      let profile = null;

      if (role === "advertiser") {
        const { data } = await supabase.from("advertisers").select("*").eq("id", user.id).single();
        profile = data;
      } else if (role === "developer") {
        const { data } = await supabase.from("developers").select("*").eq("id", user.id).single();
        profile = data;
      }

      return res.json({ user: { id: user.id, email: user.email, role }, profile });
    }

    return res.status(400).json({ error: "Unknown action. Use: signup, login, me" });

  } catch (err) {
    console.error("[Auth Error]", err);
    return res.status(500).json({ error: err.message });
  }
};
