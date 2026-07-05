/**
 * Boost Boss — notification helper.
 *
 * notify(sb, accountId, { kind, icon, title, body })  → inserts one feed row.
 *
 * Non-critical: NEVER throws. A missing table (pre-migration) is swallowed
 * silently so callers on the billing/track artery are never broken by it.
 * Pass { once: true } to skip inserting if the account already has a row of
 * this kind (welcome, first-sdk-connect, etc.).
 */
async function notify(sb, accountId, opts = {}) {
  const { kind = null, icon = null, title, body = null, once = false } = opts;
  if (!sb || !accountId || !title) return { ok: false };
  try {
    if (once && kind) {
      const { data } = await sb
        .from("notifications")
        .select("id")
        .eq("account_id", accountId)
        .eq("kind", kind)
        .limit(1);
      if (data && data.length) return { ok: true, dedup: true };
    }
    const { error } = await sb.from("notifications").insert({
      account_id: accountId, kind, icon, title, body,
    });
    if (error) {
      if (error.code === "42P01") return { ok: false, no_table: true }; // pre-migration
      return { ok: false };
    }
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
}

module.exports = { notify };
