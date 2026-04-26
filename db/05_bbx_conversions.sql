-- ═══════════════════════════════════════════════════════════════════════
-- BOOST BOSS — BBX CONVERSION TRACKING  (migration 05)
-- Apply with: psql $DATABASE_URL -f db/05_bbx_conversions.sql
-- Or paste into Supabase → SQL Editor.
--
-- Adds the conversion event type plus its metadata columns. Conversions
-- are recorded against the same auction_id as the impression/click that
-- preceded them, attributed within a 7-day window (configurable per
-- advertiser later).
--
-- What this migration adds:
--   1. Relaxes events.event_type CHECK so 'conversion' is allowed.
--   2. Adds events.conversion_type, value_cents, external_id, currency.
--   3. Per-campaign daily conversion rollup view + extension to
--      placement_daily_stats so dashboards can show ROAS / conversion
--      counts without an extra query.
-- All statements are idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Drop the restrictive CHECK constraint (only impression/click/etc) ──
do $$
declare conname text;
begin
  -- Find and drop the existing event_type CHECK by name, since postgres
  -- generates a constraint name that differs across deployments.
  select c.conname
    into conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
   where t.relname = 'events'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) ilike '%event_type%';
  if conname is not null then
    execute format('alter table public.events drop constraint %I', conname);
  end if;
end $$;

-- ── 2. Add conversion metadata columns ──
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'events' and column_name = 'conversion_type'
  ) then
    alter table public.events add column conversion_type text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'events' and column_name = 'value_cents'
  ) then
    -- USD cents stored as integer to dodge float drift. We accept and
    -- emit dollars at the API layer for backwards compat with the
    -- existing track.js / stats.js code paths.
    alter table public.events add column value_cents integer;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'events' and column_name = 'external_id'
  ) then
    -- Advertiser's own user/order id — used for dedupe and for matching
    -- BBX-attributed conversions back to the advertiser's CRM.
    alter table public.events add column external_id text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'events' and column_name = 'currency'
  ) then
    alter table public.events add column currency text default 'USD';
  end if;
end $$;

-- ── 3. Re-create the CHECK constraint, now including 'conversion' ──
alter table public.events
  add constraint events_event_type_check
  check (event_type in (
    'impression', 'click', 'close', 'skip', 'video_complete',
    'conversion', 'dismiss', 'error'
  ));

-- ── 4. Index conversions for fast dashboard rollups ──
create index if not exists events_conversion_idx
  on public.events(campaign_id, created_at desc)
  where event_type = 'conversion';

-- ── 5. Extend placement_daily_stats view to include conversion counts ──
-- Replaces the view created in migration 04 §6. We DROP first because
-- CREATE OR REPLACE VIEW only allows appending columns at the end, and
-- this rev inserts `conversions`, `conversion_value`, and `cvr` between
-- existing columns for logical grouping. No data is lost — views don't
-- store rows; they're just queries.
drop view if exists public.placement_daily_stats;
create view public.placement_daily_stats as
select
  date_trunc('day', e.created_at)::date              as date,
  e.placement_id,
  e.developer_id,
  e.surface,
  e.format,
  count(*) filter (where e.event_type = 'impression')      as impressions,
  count(*) filter (where e.event_type = 'click')           as clicks,
  count(*) filter (where e.event_type = 'video_complete')  as video_completes,
  count(*) filter (where e.event_type = 'close')           as closes,
  count(*) filter (where e.event_type = 'conversion')      as conversions,
  coalesce(sum(case when e.event_type = 'conversion' then e.value_cents else 0 end), 0) / 100.0
                                                           as conversion_value,
  coalesce(sum(e.cost), 0)             as gross_spend,
  coalesce(sum(e.developer_payout), 0) as publisher_earnings,
  case
    when count(*) filter (where e.event_type = 'impression') = 0 then null
    else (coalesce(sum(e.cost), 0)
          / count(*) filter (where e.event_type = 'impression')) * 1000
  end as ecpm,
  case
    when count(*) filter (where e.event_type = 'impression') = 0 then null
    else (count(*) filter (where e.event_type = 'click')::numeric
          / count(*) filter (where e.event_type = 'impression'))
  end as ctr,
  -- Conversion rate (conversions / clicks) — null when no clicks
  case
    when count(*) filter (where e.event_type = 'click') = 0 then null
    else (count(*) filter (where e.event_type = 'conversion')::numeric
          / count(*) filter (where e.event_type = 'click'))
  end as cvr,
  avg(e.intent_match_score) filter (where e.intent_match_score is not null)
    as avg_intent_match
from public.events e
where e.placement_id is not null
  and e.created_at >= now() - interval '90 days'
group by 1, 2, 3, 4, 5;


-- ═══════════════════════════════════════════════════════════════════════
-- Done. Sanity:
--   select column_name from information_schema.columns
--    where table_name='events' and column_name in
--      ('conversion_type','value_cents','external_id','currency');
--   -- expect 4 rows
--
--   select pg_get_constraintdef(c.oid)
--     from pg_constraint c join pg_class t on t.oid = c.conrelid
--    where t.relname = 'events' and c.contype = 'c';
--   -- check constraint includes 'conversion'
-- ═══════════════════════════════════════════════════════════════════════
