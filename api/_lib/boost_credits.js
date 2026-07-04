/**
 * Boost Boss — Boost credits (free launch network currency)
 *
 * Impression-denominated. Append-only ledger (db/36_boost_credits.sql):
 * balance = SUM(delta) per account. All helpers are non-critical and NEVER
 * throw — a Boost failure must never break the billing/track artery. Missing
 * table (pre-migration) is swallowed silently so the code can deploy ahead of
 * the SQL.
 *
 *   mintBoost(sb, accountId, n, reason, ref)  → +n Boosts (dedup on 'serve')
 *   spendBoost(sb, accountId, n, reason, ref) → −n Boosts
 *   getBoostBalance(sb, accountId)            → current balance (int)
 */

// Insert a ledger delta. Returns { ok, dedup? }. Never throws.
async function _entry(sb, accountId, delta, reason, ref) {
  if (!sb || !accountId || !Number.isFinite(delta) || delta === 0) return { ok: false };
  try {
    const { error } = await sb.from("boost_credit_ledger")
      .insert({ account_id: accountId, delta: Math.trunc(delta), reason: reason || "adjust", ref: ref || null });
    if (error) {
      if (error.code === "23505") return { ok: true, dedup: true };   // serve dedupe — already minted
      if (error.code === "42P01") return { ok: false, no_table: true }; // migration not applied yet — silent
      console.error("[boost] ledger insert:", error.message);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) { console.error("[boost] ledger ex:", e && e.message); return { ok: false }; }
}

async function mintBoost(sb, accountId, n, reason, ref) {
  return _entry(sb, accountId, Math.abs(Number(n) || 0), reason || "adjust", ref);
}
async function spendBoost(sb, accountId, n, reason, ref) {
  return _entry(sb, accountId, -Math.abs(Number(n) || 0), reason || "promote_spend", ref);
}

async function getBoostBalance(sb, accountId) {
  if (!sb || !accountId) return 0;
  try {
    const { data, error } = await sb.from("boost_credit_ledger").select("delta").eq("account_id", accountId);
    if (error) return 0;
    return (data || []).reduce((a, r) => a + (Number(r.delta) || 0), 0);
  } catch (_) { return 0; }
}

module.exports = { mintBoost, spendBoost, getBoostBalance };
