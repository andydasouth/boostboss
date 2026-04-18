#!/usr/bin/env node
/**
 * Boost Boss — End-to-end launch readiness check.
 *
 * Walks the entire money loop against the LIVE production API:
 *   1. Advertiser signs up
 *   2. Advertiser creates a campaign (starts "in_review")
 *   3. Publisher (developer) signs up
 *   4. Publisher requests an ad via MCP (with their dev API key)
 *   5. Publisher fires impression + click track events
 *   6. Stats endpoints surface the impression on both sides
 *
 * Reports each step PASS/FAIL/WARN with the actual response body so we
 * can see exactly where the live cycle breaks. Designed to be safe to
 * re-run — uses unique synthesized emails each run.
 *
 * Usage:
 *   BB_BASE=https://boostboss.ai node e2e-launch-check.js
 *   (defaults to https://boostboss.ai)
 */

const BASE = process.env.BB_BASE || "https://boostboss.ai";

const C = {
  reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m", bold: "\x1b[1m",
};

const logs = [];
function log(level, msg, detail) {
  const tag = level === "PASS" ? `${C.green}✓ PASS${C.reset}`
            : level === "FAIL" ? `${C.red}✕ FAIL${C.reset}`
            : level === "WARN" ? `${C.yellow}! WARN${C.reset}`
            : `${C.cyan}→ INFO${C.reset}`;
  console.log(`${tag}  ${msg}`);
  if (detail) console.log(`${C.dim}        ${detail}${C.reset}`);
  logs.push({ level, msg, detail });
}

async function call(path, opts = {}) {
  const url = BASE + path;
  const init = {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  };
  if (opts.body) init.body = JSON.stringify(opts.body);
  const t0 = Date.now();
  let resp, text, json;
  try {
    resp = await fetch(url, init);
    text = await resp.text();
    try { json = JSON.parse(text); } catch { /* not json */ }
  } catch (err) {
    return { ok: false, status: 0, err: err.message, ms: Date.now() - t0 };
  }
  return { ok: resp.ok, status: resp.status, json, text, ms: Date.now() - t0,
           mode: resp.headers.get("x-stats-mode") || resp.headers.get("x-mcp-mode") || resp.headers.get("x-bbx-mode"),
           devResolved: resp.headers.get("x-track-dev-resolved"),
           keyType: resp.headers.get("x-stats-key-type") || resp.headers.get("x-track-key-type") };
}

function uid() { return Math.random().toString(36).slice(2, 8); }

(async () => {
  console.log(`\n${C.bold}Boost Boss E2E Launch Check${C.reset}`);
  console.log(`${C.dim}Target: ${BASE}${C.reset}\n`);

  // ── 0. Health check ────────────────────────────────────────────────
  const health = await call("/api/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "initialize" },
  });
  if (!health.ok) {
    log("FAIL", `MCP endpoint unreachable (HTTP ${health.status})`, health.err || health.text?.slice(0, 200));
    process.exit(1);
  }
  log("PASS", `MCP endpoint reachable (${health.ms}ms, mode=${health.mode || "unknown"})`,
      `protocol=${health.json?.result?.protocolVersion}`);

  // ── 1. Advertiser signup ───────────────────────────────────────────
  const advEmail = `e2e-adv-${uid()}@boostboss.ai`;
  const advSignup = await call("/api/auth", {
    method: "POST",
    body: { action: "signup", email: advEmail, password: "test123456",
            role: "advertiser", company_name: "E2E Test Co." },
  });
  if (!advSignup.ok) {
    log("FAIL", "Advertiser signup", `HTTP ${advSignup.status}: ${advSignup.text?.slice(0, 200)}`);
    process.exit(1);
  }
  const advId = advSignup.json?.user?.id || advSignup.json?.profile?.id;
  const advToken = advSignup.json?.session?.access_token;
  log("PASS", `Advertiser signup (mode=${advSignup.json?.mode || "?"})`,
      `id=${advId} email=${advEmail}`);

  // ── 2. Campaign create ─────────────────────────────────────────────
  const campCreate = await call("/api/campaigns", {
    method: "POST",
    headers: advToken ? { Authorization: `Bearer ${advToken}` } : {},
    body: {
      action: "create",
      advertiser_id: advId,
      headline: "E2E Test — Try our AI debugger",
      subtext: "Catch Python tracebacks before they ship.",
      cta_label: "Start free trial",
      cta_url: "https://example.com/e2e",
      format: "native",
      billing_model: "cpm",
      bid_amount: 8.50,
      daily_budget: 100,
      total_budget: 1000,
      target_regions: ["global"],
      target_languages: ["en"],
      target_keywords: ["python", "debug", "traceback"],
    },
  });
  if (!campCreate.ok) {
    log("FAIL", "Campaign create", `HTTP ${campCreate.status}: ${campCreate.text?.slice(0, 200)}`);
  } else {
    const camp = campCreate.json?.campaign;
    log("PASS", `Campaign create — status=${camp?.status}`,
        `id=${camp?.id} bid=$${camp?.bid_amount} daily=$${camp?.daily_budget}`);
    if (camp?.status === "in_review") {
      log("WARN", "Campaign is in_review — won't serve until admin approves",
          "MUST FIX for self-serve advertiser flow: auto-approve OR admin notification OR review queue UX");
    }
  }
  const campId = campCreate.json?.campaign?.id;

  // ── 3. Try to approve campaign (admin path) ───────────────────────
  // Correct API: { id, decision: "approve"|"reject", notes }. Demo mode
  // accepts the advertiser token as admin (production requires real admin).
  if (campId) {
    const approve = await call("/api/campaigns", {
      method: "POST",
      headers: advToken ? { Authorization: `Bearer ${advToken}` } : {},
      body: { action: "review", id: campId, decision: "approve",
              notes: "E2E auto-approval" },
    });
    if (approve.ok) {
      log("PASS", "Campaign approval (admin)", `now status=${approve.json?.campaign?.status}`);
    } else if (approve.status === 401) {
      log("WARN", "Campaign approval requires admin auth (401)",
          "In production this is correct — but means publishers see no inventory until admins approve. Need a review-queue notification or auto-approve-on-first-campaign flow.");
    } else {
      log("WARN", `Campaign approval HTTP ${approve.status}`, approve.text?.slice(0, 200));
    }
  }

  // ── 4. Publisher (developer) signup ────────────────────────────────
  const pubEmail = `e2e-pub-${uid()}@boostboss.ai`;
  const pubSignup = await call("/api/auth", {
    method: "POST",
    body: { action: "signup", email: pubEmail, password: "test123456",
            role: "developer", app_name: "E2E Test MCP Tool" },
  });
  if (!pubSignup.ok) {
    log("FAIL", "Publisher signup", `HTTP ${pubSignup.status}: ${pubSignup.text?.slice(0, 200)}`);
    process.exit(1);
  }
  const pubProfile = pubSignup.json?.profile || {};
  const pubApiKey = pubProfile.api_key || pubProfile.developer_key || pubSignup.json?.user?.api_key;
  const pubId = pubSignup.json?.user?.id;
  log("PASS", `Publisher signup (mode=${pubSignup.json?.mode || "?"})`,
      `id=${pubId} email=${pubEmail} api_key=${pubApiKey ? pubApiKey.slice(0, 12) + "..." : "MISSING"}`);
  if (!pubApiKey) {
    log("FAIL", "Publisher API key missing from signup response",
        "Publishers can't authenticate without an api_key — onboarding is broken");
  }

  // ── 5. Publisher requests an ad via MCP ────────────────────────────
  const adReq = await call("/api/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0", id: 100, method: "tools/call",
      params: {
        name: "get_sponsored_content",
        arguments: {
          context_summary: "user is debugging a python traceback in their FastAPI app",
          format_preference: "native",
          user_region: "US",
          user_language: "en",
          session_id: `e2e_${Date.now()}`,
          developer_api_key: pubApiKey,
          host: "e2e-test.local",
        },
      },
    },
  });
  let servedAdId = null;
  if (!adReq.ok) {
    log("FAIL", "MCP get_sponsored_content", `HTTP ${adReq.status}: ${adReq.text?.slice(0, 200)}`);
  } else {
    const text = adReq.json?.result?.content?.[0]?.text;
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { /* */ }
    if (parsed.sponsored) {
      // OpenRTB: the ad object uses campaign_id (not id/creative_id).
      servedAdId = parsed.sponsored.campaign_id || parsed.sponsored.id || parsed.sponsored.creative_id;
      const benna = parsed.benna || {};
      log("PASS", `Ad served — "${parsed.sponsored.headline?.slice(0, 50)}..."`,
          `campaign_id=${servedAdId} bid=$${benna.bid_usd || benna.effective_bid_usd} latency=${benna.latency_ms || adReq.ms}ms`);
      global._trackingBeacons = parsed.sponsored.tracking || {};
    } else {
      log("WARN", `No ad returned: ${parsed.reason || "unknown"}`,
          "Publisher would see empty inventory — this kills publisher trust on day one");
    }
  }

  // ── 6. Track impression ────────────────────────────────────────────
  if (servedAdId) {
    const imp = await call("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: {
          name: "track_event",
          arguments: {
            event_type: "impression",
            ad_id: servedAdId,
            session_id: `e2e_${Date.now()}`,
            developer_api_key: pubApiKey,
            host: "e2e-test.local",
          },
        },
      },
    });
    if (!imp.ok) log("FAIL", "track_event impression", `HTTP ${imp.status}: ${imp.text?.slice(0, 200)}`);
    else log("PASS", "Impression tracked",
      `${imp.ms}ms · dev-resolved=${imp.devResolved || "?"} · key=${imp.keyType || "?"}`);

    // Click event
    const click = await call("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0", id: 102, method: "tools/call",
        params: {
          name: "track_event",
          arguments: { event_type: "click", ad_id: servedAdId,
                       session_id: `e2e_${Date.now()}`,
                       developer_api_key: pubApiKey, host: "e2e-test.local" },
        },
      },
    });
    if (!click.ok) log("FAIL", "track_event click", `HTTP ${click.status}: ${click.text?.slice(0, 200)}`);
    else log("PASS", "Click tracked", `${click.ms}ms`);
  } else {
    log("WARN", "Skipping track_event (no ad was served)");
  }

  // ── 7. Verify stats ────────────────────────────────────────────────
  await new Promise(r => setTimeout(r, 1500)); // let async writes settle

  if (pubApiKey) {
    const pubStats = await call(`/api/stats?type=developer&key=${encodeURIComponent(pubApiKey)}`);
    if (!pubStats.ok) log("FAIL", "Publisher stats", `HTTP ${pubStats.status}: ${pubStats.text?.slice(0, 200)}`);
    else {
      const s = pubStats.json || {};
      const imps = s.impressions ?? s.total_impressions ?? s.stats?.impressions ?? 0;
      const earn = s.earnings ?? s.revenue ?? s.stats?.earnings ?? 0;
      log(imps > 0 ? "PASS" : "WARN", `Publisher stats — impressions=${imps} earnings=$${earn}`,
          imps === 0 ? `Stats returned 0 despite track_event. key=${pubStats.keyType || "?"}. If key=anon, SUPABASE_SERVICE_ROLE_KEY is missing in Vercel env — RLS blocks reads.` : null);
    }
  }
  if (advId) {
    const advStats = await call(`/api/stats?type=advertiser&id=${encodeURIComponent(advId)}`);
    if (!advStats.ok) log("FAIL", "Advertiser stats", `HTTP ${advStats.status}: ${advStats.text?.slice(0, 200)}`);
    else {
      const s = advStats.json || {};
      const imps = s.impressions ?? s.total_impressions ?? s.stats?.impressions ?? 0;
      const spend = s.spend ?? s.spent ?? s.stats?.spend ?? 0;
      log(imps > 0 ? "PASS" : "WARN", `Advertiser stats — impressions=${imps} spend=$${spend}`);
    }
  }

  // ── 8. Billing balance check ───────────────────────────────────────
  const balanceCheck = await call(
    `/api/billing?action=balance&id=${encodeURIComponent(advId)}`,
    { headers: advToken ? { Authorization: `Bearer ${advToken}` } : {} }
  );
  if (!balanceCheck.ok) log("WARN", "Advertiser balance check", `HTTP ${balanceCheck.status}`);
  else log("INFO", `Advertiser balance: $${balanceCheck.json?.balance ?? "?"}`,
      `currency=${balanceCheck.json?.currency || "USD"}`);

  // ── Summary ────────────────────────────────────────────────────────
  const pass = logs.filter(l => l.level === "PASS").length;
  const fail = logs.filter(l => l.level === "FAIL").length;
  const warn = logs.filter(l => l.level === "WARN").length;

  console.log(`\n${C.bold}━━━ Summary ━━━${C.reset}`);
  console.log(`${C.green}${pass} pass${C.reset}  ${C.red}${fail} fail${C.reset}  ${C.yellow}${warn} warn${C.reset}\n`);

  if (fail === 0 && warn === 0) {
    console.log(`${C.green}${C.bold}✓ Launch loop is GO. Publisher → SDK → impression → stats → revenue all working.${C.reset}\n`);
    process.exit(0);
  } else if (fail === 0) {
    console.log(`${C.yellow}${C.bold}! Loop works but has gaps. Review WARNs before publisher invites.${C.reset}\n`);
    process.exit(0);
  } else {
    console.log(`${C.red}${C.bold}✕ Loop is broken. Fix FAILs before any publisher invite.${C.reset}\n`);
    process.exit(1);
  }
})();
