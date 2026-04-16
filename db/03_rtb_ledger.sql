-- ─────────────────────────────────────────────────────────────────────
-- Boost Boss — BBX RTB Ledger Schema
-- Apply with: psql $DATABASE_URL -f db/03_rtb_ledger.sql
-- Or paste into Supabase → SQL Editor.
--
-- This schema backs api/_lib/ledger.js and api/_lib/seats.js. The same
-- code runs against either an in-process Map (demo) or these tables
-- (production) — the transition is just env vars.
-- ─────────────────────────────────────────────────────────────────────

-- ── 1. DSP seats (one row per buy-side integration) ──────────────────
create table if not exists public.dsp_seats (
  seat_id          text primary key,
  name             text not null,
  api_key          text unique not null,
  qps_cap          int  not null default 100,
  daily_cap_usd    numeric(12,2) not null default 1000,
  status           text not null default 'active' check (status in ('active','paused','terminated')),
  contact_email    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists dsp_seats_api_key_idx on public.dsp_seats(api_key);
create index if not exists dsp_seats_status_idx  on public.dsp_seats(status);

-- ── 2. Auctions (one row per BidRequest accepted) ────────────────────
create table if not exists public.rtb_auctions (
  id             text primary key,                 -- BidRequest.id (DSP-supplied)
  seat_id        text references public.dsp_seats(seat_id),
  ts             timestamptz not null default now(),
  tmax           int,
  imp_count      int not null default 0,
  site_domain    text,
  app_bundle     text,
  raw            jsonb,                            -- full BidRequest for forensics
  created_at     timestamptz not null default now()
);

create index if not exists rtb_auctions_seat_ts_idx on public.rtb_auctions(seat_id, ts desc);
create index if not exists rtb_auctions_ts_idx      on public.rtb_auctions(ts desc);

-- ── 3. Bids (one row per Bid we returned) ────────────────────────────
create table if not exists public.rtb_bids (
  id              text primary key,                -- Bid.id
  auction_id      text not null references public.rtb_auctions(id) on delete cascade,
  imp_id          text not null,
  campaign_id     text not null,                   -- references public.campaigns(id) (declared elsewhere)
  seat_id         text references public.dsp_seats(seat_id),
  price_cpm       numeric(12,4) not null,
  adomain         text[] default '{}',
  cat             text[] default '{}',
  status          text not null default 'pending'
                  check (status in ('pending','won','lost','expired')),
  won_price_cpm   numeric(12,4),
  won_at          timestamptz,
  lost_reason     int,
  lost_at         timestamptz,
  ts              timestamptz not null default now()
);

create index if not exists rtb_bids_auction_idx   on public.rtb_bids(auction_id);
create index if not exists rtb_bids_campaign_idx  on public.rtb_bids(campaign_id);
create index if not exists rtb_bids_seat_ts_idx   on public.rtb_bids(seat_id, ts desc);
create index if not exists rtb_bids_status_idx    on public.rtb_bids(status) where status = 'pending';

-- ── 4. Atomic budget deduction RPC ───────────────────────────────────
-- Called by api/_lib/ledger.js → recordWin(). Single-statement update so
-- Postgres serializes concurrent wins on the same campaign.
--
-- Returns:
--   { spent_today, spent_total, daily_budget, total_budget } as JSON
-- Returns NULL if the campaign would exceed daily_budget after deduction
-- (caller should treat as "would have over-spent" — campaign is paused
-- on the application side).
create or replace function public.bbx_deduct_campaign_budget(
  p_campaign_id text,
  p_amount_usd  numeric
) returns jsonb
language plpgsql
as $$
declare
  r record;
begin
  update public.campaigns
     set spent_today = coalesce(spent_today, 0) + p_amount_usd,
         spent_total = coalesce(spent_total, 0) + p_amount_usd,
         updated_at  = now()
   where id = p_campaign_id
     and (daily_budget is null
          or coalesce(spent_today, 0) + p_amount_usd <= daily_budget)
  returning spent_today, spent_total, daily_budget, total_budget
       into r;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'spent_today', r.spent_today,
    'spent_total', r.spent_total,
    'daily_budget', r.daily_budget,
    'total_budget', r.total_budget
  );
end;
$$;

-- ── 5. Daily reset cron (Supabase pg_cron) ───────────────────────────
-- Resets spent_today every midnight UTC. Manual install:
--   select cron.schedule('bbx-reset-daily-spend', '0 0 * * *',
--          $$ update public.campaigns set spent_today = 0 $$);

-- ── 6. Spend rollup view (used by op=report) ─────────────────────────
create or replace view public.rtb_seat_spend_24h as
select
  b.seat_id,
  count(*) filter (where b.status = 'won')           as wins,
  count(*) filter (where b.status = 'lost')          as losses,
  count(*)                                           as bids,
  sum(b.won_price_cpm) filter (where b.status = 'won') / 1000.0
                                                     as gross_spend_usd,
  avg(b.won_price_cpm) filter (where b.status = 'won')
                                                     as avg_cpm_won
from public.rtb_bids b
where b.ts >= now() - interval '24 hours'
group by b.seat_id;

-- ── 7. Seed sample seats for staging ─────────────────────────────────
insert into public.dsp_seats (seat_id, name, api_key, qps_cap, daily_cap_usd, status)
values
  ('seat_demo',       'BBX Demo DSP',           'bb_seat_demo_replace_in_prod',       50,    5000, 'active'),
  ('seat_tradedesk',  'The Trade Desk (sandbox)','bb_seat_ttd_replace_in_prod',     5000, 250000, 'active'),
  ('seat_dv360',      'DV360 (sandbox)',        'bb_seat_dv360_replace_in_prod',   5000, 250000, 'active')
on conflict (seat_id) do nothing;

-- ── 8. Row-level security ────────────────────────────────────────────
alter table public.dsp_seats   enable row level security;
alter table public.rtb_auctions enable row level security;
alter table public.rtb_bids    enable row level security;

-- Service role bypasses RLS; the API uses SUPABASE_SERVICE_ROLE_KEY.
-- No anon/authenticated policies are added — these tables are server-only.
