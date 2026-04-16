#!/usr/bin/env node
/**
 * Boost Boss — Post-deploy smoke test
 *
 * Run after deployment to verify all critical endpoints respond.
 * Usage: node scripts/verify-deploy.js [base-url]
 *
 * Default base URL: https://boostboss.ai
 * Override:         node scripts/verify-deploy.js https://your-preview.vercel.app
 */

const BASE = process.argv[2] || "https://boostboss.ai";
let passed = 0, failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log("  \x1b[32m✓\x1b[0m  " + name);
    passed++;
  } catch (e) {
    console.log("  \x1b[31m✗\x1b[0m  " + name + ": " + e.message);
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  console.log(`\nBoost Boss deploy verification → ${BASE}\n`);

  // ── Static pages ──
  await check("index.html loads", async () => {
    const r = await fetch(BASE + "/");
    assert(r.ok, `status ${r.status}`);
    const t = await r.text();
    assert(t.includes("Boost Boss"), "missing brand name");
  });

  for (const page of ["/ads.html", "/publish.html", "/exchange.html", "/docs.html", "/trust.html", "/status.html", "/playground.html", "/signup.html", "/admin.html"]) {
    await check(`${page} loads`, async () => {
      const r = await fetch(BASE + page);
      assert(r.ok, `status ${r.status}`);
    });
  }

  // ── Trust artifacts ──
  for (const f of ["/sellers.json", "/ads.txt", "/app-ads.txt", "/.well-known/security.txt"]) {
    await check(`${f} is reachable`, async () => {
      const r = await fetch(BASE + f);
      assert(r.ok, `status ${r.status}`);
    });
  }

  // ── Auth API ──
  await check("POST /api/auth?action=demo returns a session", async () => {
    const r = await fetch(BASE + "/api/auth?action=demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "advertiser" }),
    });
    assert(r.ok, `status ${r.status}`);
    const j = await r.json();
    assert(j.session && j.session.access_token, "no access_token");
  });

  // ── RTB API ──
  await check("GET /api/rtb?op=status returns adapter metadata", async () => {
    const r = await fetch(BASE + "/api/rtb?op=status");
    assert(r.ok, `status ${r.status}`);
    const j = await r.json();
    assert(j.openrtb_version === "2.6", "wrong openrtb version");
    assert(j.auction_type === 1, "not first-price");
  });

  await check("POST /api/rtb returns a bid (anonymous demo)", async () => {
    const r = await fetch(BASE + "/api/rtb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "verify_" + Date.now(),
        at: 1, tmax: 200, cur: ["USD"],
        imp: [{ id: "1", tagid: "test", bidfloor: 0.5,
          native: { ver: "1.2", request: '{"ver":"1.2","assets":[{"id":1,"required":1,"title":{"len":60}}]}' }
        }],
        site: { domain: "test.com", keywords: "python debug" },
        device: { geo: { country: "USA", region: "us-west" } },
      }),
    });
    // In strict mode (production) this may 401 — that's also a valid response.
    if (r.status === 401) {
      console.log("       ↳ seat auth is enforced (production mode) — pass");
      return;
    }
    assert(r.status === 200 || r.status === 204, `unexpected status ${r.status}`);
    if (r.status === 200) {
      const j = await r.json();
      assert(j.seatbid && j.seatbid.length > 0, "no seatbid");
    }
  });

  // ── Billing API ──
  await check("GET /api/billing?action=balance returns valid response", async () => {
    const r = await fetch(BASE + "/api/billing?action=balance&id=adv_demo_verify");
    // In Stripe mode, unknown customer returns 404 — that's valid behavior
    assert(r.status === 200 || r.status === 404, `unexpected status ${r.status}`);
    const j = await r.json();
    if (r.status === 200) assert(typeof j.balance === "number", "balance not a number");
    if (r.status === 404) console.log("       ↳ Stripe mode: no customer yet (expected on fresh setup)");
  });

  // ── Auth mode header ──
  await check("x-auth-mode header is present on auth endpoint", async () => {
    const r = await fetch(BASE + "/api/auth?action=demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "advertiser" }),
    });
    const mode = r.headers.get("x-auth-mode");
    assert(mode === "demo" || mode === "supabase", `unexpected x-auth-mode: ${mode}`);
    console.log(`       ↳ auth mode: ${mode}`);
  });

  await check("x-billing-mode header is present on billing endpoint", async () => {
    const r = await fetch(BASE + "/api/billing?action=balance&id=x");
    const mode = r.headers.get("x-billing-mode");
    assert(mode === "demo" || mode === "stripe", `unexpected x-billing-mode: ${mode}`);
    console.log(`       ↳ billing mode: ${mode}`);
  });

  // ── Summary ──
  console.log();
  if (failed) {
    console.log(`\x1b[31m${failed} failed\x1b[0m, ${passed} passed.`);
    process.exit(1);
  } else {
    console.log(`\x1b[32m${passed} checks passed.\x1b[0m All systems operational.`);
  }
})();
