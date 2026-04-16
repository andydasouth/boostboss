/**
 * Boost Boss — DSP Seat Registry
 *
 * Every external DSP that bids into BBX gets a "seat" — equivalent to an
 * Account on Trade Desk or DV360. The seat carries:
 *   • seat_id        — short identifier echoed in seatbid.seat
 *   • name           — human-readable
 *   • api_key        — bearer token; must be presented on every BidRequest
 *   • qps_cap        — soft per-second rate limit
 *   • daily_cap_usd  — daily spend ceiling, enforced by the ledger on win
 *   • status         — active | paused | terminated
 *
 * Two execution modes mirror the rest of /api/_lib:
 *   • PRODUCTION — `dsp_seats` table in Supabase
 *   • DEMO       — in-process Map seeded with three sample seats so the
 *                  exchange page and the test suite work without infra
 */

const crypto = require("crypto");

const HAS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
);

const SEAT_AUTH_REQUIRED =
  process.env.BBX_SEAT_AUTH_REQUIRED === "true" ||
  process.env.NODE_ENV === "production";

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
  } catch (_) {
    return null;
  }
}

// ── In-process registry ─────────────────────────────────────────────────
// Seeded with sample seats. The api_key values are deterministic so
// integration tests and curl-on-the-docs-page work consistently.
function seedKey(seatId) {
  const secret = process.env.JWT_SECRET || "bbx-demo-jwt-secret-do-not-use-in-prod";
  return "bb_seat_" + crypto.createHash("sha256").update("seat:" + seatId + ":" + secret).digest("hex").slice(0, 40);
}

const DEMO_SEATS = new Map([
  ["seat_demo", {
    seat_id: "seat_demo", name: "BBX Demo DSP",
    api_key: seedKey("seat_demo"),
    qps_cap: 50, daily_cap_usd: 5000,
    status: "active", created_at: "2026-01-15T00:00:00Z",
  }],
  ["seat_tradedesk", {
    seat_id: "seat_tradedesk", name: "The Trade Desk (sandbox)",
    api_key: seedKey("seat_tradedesk"),
    qps_cap: 5000, daily_cap_usd: 250000,
    status: "active", created_at: "2026-02-01T00:00:00Z",
  }],
  ["seat_dv360", {
    seat_id: "seat_dv360", name: "DV360 (sandbox)",
    api_key: seedKey("seat_dv360"),
    qps_cap: 5000, daily_cap_usd: 250000,
    status: "active", created_at: "2026-02-01T00:00:00Z",
  }],
]);

// ── Per-process QPS counter (sliding 1s window) ─────────────────────────
const _qps = new Map(); // seat_id → { windowStart, count }
function checkQps(seat) {
  if (!seat || !seat.qps_cap) return true;
  const now = Date.now();
  const win = _qps.get(seat.seat_id) || { windowStart: now, count: 0 };
  if (now - win.windowStart > 1000) { win.windowStart = now; win.count = 0; }
  win.count += 1;
  _qps.set(seat.seat_id, win);
  return win.count <= seat.qps_cap;
}

// ── Public API ──────────────────────────────────────────────────────────

/** Look up a seat by API key. Returns the seat row or null. */
async function findByApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== "string") return null;
  const sb = supa();
  if (sb) {
    const { data, error } = await sb
      .from("dsp_seats")
      .select("*")
      .eq("api_key", apiKey)
      .eq("status", "active")
      .single();
    if (error || !data) return null;
    return data;
  }
  for (const s of DEMO_SEATS.values()) {
    if (s.api_key === apiKey && s.status === "active") return s;
  }
  return null;
}

/** Look up a seat by seat_id (for the reporting endpoint). */
async function findById(seatId) {
  if (!seatId) return null;
  const sb = supa();
  if (sb) {
    const { data } = await sb.from("dsp_seats").select("*").eq("seat_id", seatId).single();
    return data || null;
  }
  return DEMO_SEATS.get(seatId) || null;
}

/**
 * Authenticate an incoming HTTP request.
 *
 * Returns: { ok: true, seat } | { ok: false, status, nbr, error }
 *
 * Auth is REQUIRED when BBX_SEAT_AUTH_REQUIRED=true OR NODE_ENV=production.
 * In demo deploys we accept anonymous bids (returning a synthetic "seat_anon"
 * seat) so the public exchange page and curl examples still work — but we
 * tag those auctions in the ledger so they can never be invoiced.
 */
async function authenticate(req) {
  const hdr = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const apiKey = hdr.replace(/^Bearer\s+/i, "").trim() || null;

  if (!apiKey) {
    if (SEAT_AUTH_REQUIRED) {
      return { ok: false, status: 401, nbr: 2, error: "Missing Authorization: Bearer <seat_api_key>" };
    }
    return {
      ok: true,
      seat: {
        seat_id: "seat_anon",
        name: "Anonymous (demo only — non-billable)",
        qps_cap: 10, daily_cap_usd: 0,
        status: "active",
        billable: false,
      },
    };
  }

  const seat = await findByApiKey(apiKey);
  if (!seat) return { ok: false, status: 401, nbr: 2, error: "Unknown or revoked seat API key" };

  if (!checkQps(seat)) {
    return { ok: false, status: 429, nbr: 1, error: `QPS limit exceeded (cap=${seat.qps_cap}/s)` };
  }

  return { ok: true, seat: { ...seat, billable: true } };
}

/** Issue a new seat (admin only — placeholder for the dashboard wire-up). */
async function provisionSeat({ name, qps_cap = 100, daily_cap_usd = 1000 }) {
  const seat_id = "seat_" + crypto.randomBytes(4).toString("hex");
  const api_key = "bb_seat_" + crypto.randomBytes(20).toString("hex");
  const row = {
    seat_id, name, api_key, qps_cap, daily_cap_usd,
    status: "active", created_at: new Date().toISOString(),
  };
  const sb = supa();
  if (sb) {
    const { error } = await sb.from("dsp_seats").insert(row);
    if (error) throw new Error("Seat provisioning failed: " + error.message);
  } else {
    DEMO_SEATS.set(seat_id, row);
  }
  return row;
}

/** List all seats (admin). In demo mode this returns the seeded set. */
async function listSeats() {
  const sb = supa();
  if (sb) {
    const { data } = await sb.from("dsp_seats").select("*").order("created_at");
    return data || [];
  }
  return [...DEMO_SEATS.values()];
}

module.exports = {
  authenticate,
  findByApiKey,
  findById,
  provisionSeat,
  listSeats,
  HAS_SUPABASE,
  SEAT_AUTH_REQUIRED,
  // Test helpers
  _DEMO_SEATS: DEMO_SEATS,
  _resetQps: () => _qps.clear(),
};
