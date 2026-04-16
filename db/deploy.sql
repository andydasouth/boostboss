-- ═══════════════════════════════════════════════════════════════════════
-- BOOST BOSS — FULL PRODUCTION SCHEMA
-- Run in Supabase SQL Editor (one-shot). Idempotent — safe to re-run.
-- Combines: supabase-schema.sql + auth-policies.sql + rtb-ledger.sql
-- Generated: 2026-04-16
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. CORE TABLES ─────────────────────────────────────────────────────

create table if not exists public.advertisers (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  company_name  text not null,
  password_hash text,
  balance       numeric(12,2) default 0.00,
  stripe_customer_id text,           -- Stripe customer for deposits/invoicing
  status        text default 'active' check (status in ('active','suspended','pending')),
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create table if not exists public.developers (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique not null,
  app_name           text not null,
  api_key            text unique not null default 'bb_dev_' || substr(md5(random()::text), 1, 24),
  app_id             text unique not null default 'app_' || substr(md5(random()::text), 1, 12),
  publisher_domain   text,                    -- site.domain for payout matching (e.g. cursor.com)
  stripe_account_id  text,                    -- Stripe Connect account for payouts
  revenue_share_pct  numeric(5,2) default 85.00,  -- updated from 65% to match billing.js 85/15 split
  total_earnings     numeric(12,2) default 0.00,
  mcp_endpoint       text default 'https://boostboss.ai/api/mcp',
  format_corner      boolean default true,
  format_fullscreen  boolean default true,
  format_video       boolean default true,
  format_native      boolean default true,
  status             text default 'active' check (status in ('active','suspended','pending')),
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

create table if not exists public.campaigns (
  id               uuid primary key default gen_random_uuid(),
  advertiser_id    uuid references public.advertisers(id) on delete cascade,
  name             text not null,
  status           text default 'in_review' check (status in ('active','paused','in_review','completed','rejected')),
  format           text not null check (format in ('image','video','native')),
  headline         text not null,
  subtext          text,
  media_url        text,
  poster_url       text,
  cta_label        text default 'Learn More',
  cta_url          text not null,
  adomain          text[] default '{}',       -- advertiser domains (badv filtering)
  iab_cat          text[] default '{}',       -- IAB content categories (bcat filtering)
  target_keywords  text[] default '{}',
  target_regions   text[] default '{global}',
  target_languages text[] default '{en}',
  target_cpa       numeric(8,2),              -- target cost per acquisition for Benna
  billing_model    text default 'cpm' check (billing_model in ('cpm','cpc','cpv')),
  bid_amount       numeric(8,2) default 5.00,
  daily_budget     numeric(10,2) default 50.00,
  total_budget     numeric(12,2) default 1000.00,
  spent_today      numeric(10,2) default 0.00,
  spent_total      numeric(12,2) default 0.00,
  skippable_after_sec int default 3,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create table if not exists public.events (
  id              uuid primary key default gen_random_uuid(),
  event_type      text not null check (event_type in ('impression','click','close','skip','video_complete')),
  campaign_id     uuid references public.campaigns(id) on delete set null,
  developer_id    uuid references public.developers(id) on delete set null,
  session_id      text,
  ip_country      text default 'unknown',
  ip_region       text default 'unknown',
  ip_city         text default 'unknown',
  user_language   text default 'en',
  user_agent      text,
  cost            numeric(8,4) default 0.00,
  developer_payout numeric(8,4) default 0.00,
  created_at      timestamptz default now()
);

create table if not exists public.payouts (
  id                 uuid primary key default gen_random_uuid(),
  developer_id       uuid references public.developers(id) on delete cascade,
  amount             numeric(12,2) not null,
  period_start       date not null,
  period_end         date not null,
  status             text default 'pending' check (status in ('pending','processing','paid','failed')),
  stripe_transfer_id text,
  created_at         timestamptz default now()
);

create table if not exists public.daily_stats (
  id               uuid primary key default gen_random_uuid(),
  date             date not null,
  campaign_id      uuid references public.campaigns(id) on delete cascade,
  developer_id     uuid references public.developers(id) on delete set null,
  impressions      int default 0,
  clicks           int default 0,
  video_completes  int default 0,
  skips            int default 0,
  closes           int default 0,
  spend            numeric(10,2) default 0.00,
  developer_earnings numeric(10,2) default 0.00,
  unique(date, campaign_id, developer_id)
);

create table if not exists public.transactions (
  id                uuid primary key default gen_random_uuid(),
  advertiser_id     uuid references public.advertisers(id) on delete cascade,
  developer_id      uuid references public.developers(id) on delete set null,
  type              text not null check (type in ('deposit','spend','refund','payout')),
  amount            numeric(12,4) not null,
  description       text,
  stripe_session_id text,
  stripe_transfer_id text,
  status            text default 'completed' check (status in ('pending','completed','failed')),
  created_at        timestamptz default now()
);

create index if not exists idx_transactions_advertiser on public.transactions(advertiser_id, created_at desc);
create index if not exists idx_transactions_developer on public.transactions(developer_id, created_at desc);

-- ── 2. DSP SEATS (RTB buy-side integrations) ──────────────────────────

create table if not exists public.dsp_seats (
  seat_id        text primary key,
  name           text not null,
  api_key        text unique not null,
  contact_email  text,
  qps_cap        int not null default 100,
  daily_cap_usd  numeric(12,2) not null default 1000,
  status         text not null default 'active' check (status in ('active','paused','terminated')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── 3. RTB AUCTION LEDGER ─────────────────────────────────────────────

create table if not exists public.rtb_auctions (
  id           text primary key,                    -- BidRequest.id
  seat_id      text references public.dsp_seats(seat_id),
  ts           timestamptz not null default now(),
  tmax         int,
  imp_count    int not null default 0,
  site_domain  text,
  app_bundle   text,
  raw          jsonb,
  created_at   timestamptz not null default now()
);

create table if not exists public.rtb_bids (
  id              text primary key,                 -- Bid.id
  auction_id      text not null references public.rtb_auctions(id) on delete cascade,
  imp_id          text not null,
  campaign_id     text not null,                    -- UUID as text; matches campaigns.id::text
  seat_id         text references public.dsp_seats(seat_id),
  price_cpm       numeric(12,4) not null,
  adomain         text[] default '{}',
  cat             text[] default '{}',
  developer_id    text,                             -- publisher who earned the revenue
  developer_domain text,                            -- site_domain or app_bundle of the publisher
  status          text not null default 'pending'
                  check (status in ('pending','won','lost','expired')),
  won_price_cpm   numeric(12,4),
  won_at          timestamptz,
  lost_reason     int,
  lost_at         timestamptz,
  ts              timestamptz not null default now()
);

-- ── 4. INDEXES ────────────────────────────────────────────────────────

create index if not exists idx_campaigns_advertiser   on public.campaigns(advertiser_id);
create index if not exists idx_campaigns_status       on public.campaigns(status);
create index if not exists idx_campaigns_keywords     on public.campaigns using gin(target_keywords);
create index if not exists idx_events_campaign        on public.events(campaign_id);
create index if not exists idx_events_developer       on public.events(developer_id);
create index if not exists idx_events_created         on public.events(created_at);
create index if not exists idx_events_type            on public.events(event_type);
create index if not exists idx_daily_stats_date       on public.daily_stats(date);
create index if not exists idx_daily_stats_campaign   on public.daily_stats(campaign_id);
create index if not exists idx_daily_stats_developer  on public.daily_stats(developer_id);
create index if not exists dsp_seats_api_key_idx      on public.dsp_seats(api_key);
create index if not exists dsp_seats_status_idx       on public.dsp_seats(status);
create index if not exists rtb_auctions_seat_ts_idx   on public.rtb_auctions(seat_id, ts desc);
create index if not exists rtb_auctions_ts_idx        on public.rtb_auctions(ts desc);
create index if not exists rtb_bids_auction_idx       on public.rtb_bids(auction_id);
create index if not exists rtb_bids_campaign_idx      on public.rtb_bids(campaign_id);
create index if not exists rtb_bids_seat_ts_idx       on public.rtb_bids(seat_id, ts desc);
create index if not exists rtb_bids_status_idx        on public.rtb_bids(status) where status = 'pending';

-- ── 5. ROW-LEVEL SECURITY ─────────────────────────────────────────────

alter table public.advertisers   enable row level security;
alter table public.developers    enable row level security;
alter table public.campaigns     enable row level security;
alter table public.events        enable row level security;
alter table public.payouts       enable row level security;
alter table public.daily_stats   enable row level security;
alter table public.dsp_seats     enable row level security;
alter table public.rtb_auctions  enable row level security;
alter table public.rtb_bids      enable row level security;

-- Core policies (idempotent: drop if exists + re-create)
do $$ begin
  drop policy if exists "Active campaigns are readable" on campaigns;
  create policy "Active campaigns are readable" on campaigns for select using (status = 'active');

  drop policy if exists "Events can be inserted" on events;
  create policy "Events can be inserted" on events for insert with check (true);

  drop policy if exists "Stats are readable" on daily_stats;
  create policy "Stats are readable" on daily_stats for select using (true);

  drop policy if exists "Developers read own data" on developers;
  create policy "Developers read own data" on developers for select using (true);

  drop policy if exists "Advertisers manage own data" on advertisers;
  create policy "Advertisers manage own data" on advertisers for all using (auth.uid() = id);

  drop policy if exists "Developers manage own data" on developers;
  create policy "Developers manage own data" on developers for all using (auth.uid() = id);

  drop policy if exists "Advertisers manage own campaigns" on campaigns;
  create policy "Advertisers manage own campaigns" on campaigns for all using (advertiser_id = auth.uid());

  drop policy if exists "Allow signup inserts for advertisers" on advertisers;
  create policy "Allow signup inserts for advertisers" on advertisers for insert with check (true);

  drop policy if exists "Allow signup inserts for developers" on developers;
  create policy "Allow signup inserts for developers" on developers for insert with check (true);

  drop policy if exists "Developers read own events" on events;
  create policy "Developers read own events" on events for select using (developer_id = auth.uid());

  drop policy if exists "Developers read own payouts" on payouts;
  create policy "Developers read own payouts" on payouts for select using (developer_id = auth.uid());

  drop policy if exists "Developers read own daily stats" on daily_stats;
  create policy "Developers read own daily stats" on daily_stats for select using (developer_id = auth.uid());
end $$;

-- RTB tables are server-only (service_role bypasses RLS), no anon policies.

-- ── 6. ATOMIC BUDGET DEDUCTION RPC ───────────────────────────────────

create or replace function public.bbx_deduct_campaign_budget(
  p_campaign_id text,
  p_amount_usd  numeric
) returns jsonb
language plpgsql as $$
declare r record;
begin
  update public.campaigns
     set spent_today = coalesce(spent_today, 0) + p_amount_usd,
         spent_total = coalesce(spent_total, 0) + p_amount_usd,
         updated_at  = now()
   where id::text = p_campaign_id
     and (daily_budget is null or coalesce(spent_today, 0) + p_amount_usd <= daily_budget)
  returning spent_today, spent_total, daily_budget, total_budget into r;
  if not found then return null; end if;
  return jsonb_build_object(
    'spent_today', r.spent_today, 'spent_total', r.spent_total,
    'daily_budget', r.daily_budget, 'total_budget', r.total_budget
  );
end; $$;

-- ── 6b. ATOMIC ADVERTISER BALANCE CREDIT RPC ────────────────────────
-- Called by the Stripe webhook on checkout.session.completed.
-- Atomic increment avoids read-then-write race on concurrent deposits.
create or replace function public.bbx_credit_advertiser_balance(
  p_advertiser_id text,
  p_amount_usd numeric
) returns jsonb
language plpgsql as $$
declare
  new_balance numeric;
begin
  update public.advertisers
     set balance = coalesce(balance, 0) + p_amount_usd,
         updated_at = now()
   where id::text = p_advertiser_id
  returning balance into new_balance;

  if not found then return null; end if;
  return jsonb_build_object('balance', new_balance, 'credited', p_amount_usd);
end; $$;

-- ── 7a. DAILY STATS AGGREGATION RPC ──────────────────────────────────
-- Called by: POST /api/stats?type=aggregate&date=YYYY-MM-DD
-- Rolls up the events table into daily_stats for a given date.
-- Idempotent: uses ON CONFLICT to upsert.
create or replace function public.bbx_aggregate_daily_stats(
  p_date date
) returns jsonb
language plpgsql as $$
declare
  row_count int;
begin
  insert into public.daily_stats (date, campaign_id, developer_id,
    impressions, clicks, video_completes, skips, closes, spend, developer_earnings)
  select
    p_date,
    e.campaign_id,
    e.developer_id,
    count(*) filter (where e.event_type = 'impression'),
    count(*) filter (where e.event_type = 'click'),
    count(*) filter (where e.event_type = 'video_complete'),
    count(*) filter (where e.event_type = 'skip'),
    count(*) filter (where e.event_type = 'close'),
    coalesce(sum(e.cost), 0),
    coalesce(sum(e.developer_payout), 0)
  from public.events e
  where e.created_at >= p_date::timestamp
    and e.created_at < (p_date + interval '1 day')::timestamp
  group by e.campaign_id, e.developer_id
  on conflict (date, campaign_id, developer_id)
  do update set
    impressions = excluded.impressions,
    clicks = excluded.clicks,
    video_completes = excluded.video_completes,
    skips = excluded.skips,
    closes = excluded.closes,
    spend = excluded.spend,
    developer_earnings = excluded.developer_earnings;

  get diagnostics row_count = row_count;
  return jsonb_build_object('rows_upserted', row_count, 'date', p_date);
end; $$;

-- ── 7b. DAILY SPEND RESET (enable via Supabase pg_cron) ─────────────
-- select cron.schedule('bbx-reset-daily-spend', '0 0 * * *',
--        $$ update public.campaigns set spent_today = 0 $$);
-- ── 7c. DAILY STATS CRON (enable via Supabase pg_cron) ──────────────
-- select cron.schedule('bbx-daily-stats-etl', '5 0 * * *',
--        $$ select bbx_aggregate_daily_stats((current_date - interval '1 day')::date) $$);

-- ── 8. SPEND ROLLUP VIEW ────────────────────────────────────────────

create or replace view public.rtb_seat_spend_24h as
select
  b.seat_id,
  count(*) filter (where b.status = 'won')              as wins,
  count(*) filter (where b.status = 'lost')             as losses,
  count(*)                                              as bids,
  coalesce(sum(b.won_price_cpm) filter (where b.status = 'won'), 0) / 1000.0 as gross_spend_usd,
  avg(b.won_price_cpm) filter (where b.status = 'won') as avg_cpm_won
from public.rtb_bids b
where b.ts >= now() - interval '24 hours'
group by b.seat_id;

-- ── 9. SEED DATA ────────────────────────────────────────────────────

-- Advertisers
insert into public.advertisers (id, email, company_name, balance) values
  ('a0000000-0000-0000-0000-000000000001', 'demo@framer.com',  'Framer',  5000.00),
  ('a0000000-0000-0000-0000-000000000002', 'demo@vercel.com',  'Vercel',  8000.00),
  ('a0000000-0000-0000-0000-000000000003', 'demo@cursor.com',  'Cursor',  3000.00),
  ('a0000000-0000-0000-0000-000000000004', 'demo@notion.so',   'Notion',  6000.00)
on conflict (id) do nothing;

-- Developers
insert into public.developers (id, email, app_name, api_key, app_id, publisher_domain) values
  ('d0000000-0000-0000-0000-000000000001', 'demo@myaiapp.com',   'MyAI Chat', 'bb_dev_demo_key_001', 'app_demo001', 'myaiapp.com'),
  ('d0000000-0000-0000-0000-000000000002', 'demo@openwebui.com', 'Open WebUI','bb_dev_demo_key_002', 'app_demo002', 'openwebui.com')
on conflict (id) do nothing;

-- Campaigns
insert into public.campaigns (advertiser_id, name, status, format, headline, subtext, media_url,
  cta_label, cta_url, adomain, iab_cat, target_keywords, target_regions, target_languages,
  target_cpa, billing_model, bid_amount, daily_budget, total_budget)
values
  ('a0000000-0000-0000-0000-000000000001', 'Framer Landing Pages', 'active', 'image',
   'Build stunning sites — no code needed', 'Framer · Free for 30 days · 2M+ creators',
   'https://placehold.co/540x304/f97316/ffffff?text=Framer',
   'Try Free', 'https://framer.com',
   '{"framer.com"}', '{"IAB19-6"}',
   '{landing page,design,website,no-code}', '{global}', '{en}',
   8.00, 'cpm', 5.00, 50.00, 1000.00),
  ('a0000000-0000-0000-0000-000000000002', 'Vercel Deploy', 'active', 'image',
   'Deploy in seconds. Scale forever.', 'Vercel · Free hobby plan',
   'https://placehold.co/540x304/000000/ffffff?text=Vercel',
   'Deploy Now', 'https://vercel.com',
   '{"vercel.com"}', '{"IAB19-30"}',
   '{deploy,hosting,server,scale,next.js}', '{global}', '{en}',
   12.00, 'cpm', 6.00, 80.00, 2000.00),
  ('a0000000-0000-0000-0000-000000000003', 'Cursor AI IDE', 'active', 'video',
   'Code 10x faster with AI', 'Cursor · AI-first IDE · 1M+ developers',
   'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
   'Download Free', 'https://cursor.com',
   '{"cursor.com"}', '{"IAB19-6"}',
   '{code,programming,IDE,developer,debug}', '{global}', '{en}',
   6.00, 'cpv', 0.10, 100.00, 3000.00),
  ('a0000000-0000-0000-0000-000000000004', 'Notion AI Workspace', 'active', 'image',
   'All your work. One tool. AI-powered.', 'Notion · Free for personal · 30M+ teams',
   'https://placehold.co/540x304/0ea5e9/ffffff?text=Notion+AI',
   'Get Notion Free', 'https://notion.so',
   '{"notion.so"}', '{"IAB19-15"}',
   '{notes,organize,project,team,wiki}', '{global}', '{en}',
   10.00, 'cpc', 0.40, 60.00, 1500.00)
on conflict do nothing;

-- DSP seats
insert into public.dsp_seats (seat_id, name, api_key, qps_cap, daily_cap_usd)
values
  ('seat_demo',      'BBX Demo DSP',           'bb_seat_demo_replace_in_prod',     50,   5000),
  ('seat_tradedesk', 'The Trade Desk (sandbox)','bb_seat_ttd_replace_in_prod',   5000, 250000),
  ('seat_dv360',     'DV360 (sandbox)',         'bb_seat_dv360_replace_in_prod', 5000, 250000)
on conflict (seat_id) do nothing;

-- Dashboard demo stats (14 days of random-ish data per campaign)
insert into public.daily_stats (date, campaign_id, developer_id, impressions, clicks,
  video_completes, skips, closes, spend, developer_earnings)
select
  (current_date - (d || ' days')::interval)::date,
  c.id,
  'd0000000-0000-0000-0000-000000000001'::uuid,
  (random() * 5000 + 1000)::int,
  (random() * 100 + 20)::int,
  case when c.format = 'video' then (random() * 50 + 10)::int else 0 end,
  (random() * 30)::int,
  (random() * 200 + 50)::int,
  round((random() * 30 + 5)::numeric, 2),
  round((random() * 20 + 3)::numeric, 2)
from generate_series(0, 13) as d
cross join public.campaigns c
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════
-- Done. Verify with:  SELECT count(*) FROM campaigns WHERE status = 'active';
-- ═══════════════════════════════════════════════════════════════════════
