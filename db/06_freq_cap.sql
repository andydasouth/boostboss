-- ═══════════════════════════════════════════════════════════════════════
-- BOOST BOSS — FREQUENCY CAP SUPPORT  (migration 06)
-- Apply with: psql $DATABASE_URL -f db/06_freq_cap.sql
-- Or paste into Supabase → SQL Editor.
--
-- Adds the anonymous_id column the auction handler needs to enforce the
-- placement-level freq cap (placements.freq_cap_per_user_per_day).
-- The SDK persists a UUID in localStorage and sends it on every
-- ad_request; track.js writes it onto the impression row; the MCP
-- auction handler queries impression counts per (anonymous_id,
-- placement_id, today) and rejects bids when the user has already seen
-- their daily quota for that slot.
--
-- All statements idempotent.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Add anonymous_id column ──
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'events' and column_name = 'anonymous_id'
  ) then
    alter table public.events add column anonymous_id text;
  end if;
end $$;

-- ── 2. Index for the freq-cap query ──
-- The auction handler joins on (anonymous_id, placement_id, today) so a
-- composite index makes the lookup ~1ms even at millions of rows.
-- Filtering by event_type = 'impression' inside the index keeps it small
-- (clicks, conversions, etc. don't count against freq cap).
create index if not exists events_freq_cap_idx
  on public.events(anonymous_id, placement_id, created_at)
  where event_type = 'impression' and anonymous_id is not null;

-- ── 3. Convenience function: count today's impressions for a user / slot ──
-- Used by api/mcp.js eligibility filter; also handy for ad-hoc debugging.
create or replace function public.bbx_freq_cap_count(
  p_anonymous_id text,
  p_placement_id text
) returns int
language sql stable
as $$
  select count(*)::int
    from public.events
   where event_type = 'impression'
     and anonymous_id = p_anonymous_id
     and placement_id = p_placement_id
     and created_at >= date_trunc('day', now());
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- Sanity:
--   select column_name from information_schema.columns
--    where table_name='events' and column_name='anonymous_id';
--   -- expect 1 row
--
--   select bbx_freq_cap_count('uuh_test', 'plc_demo001_sidebar');
--   -- expect 0 (or however many test impressions you've fired)
-- ═══════════════════════════════════════════════════════════════════════
