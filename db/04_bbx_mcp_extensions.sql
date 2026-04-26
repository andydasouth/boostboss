-- ═══════════════════════════════════════════════════════════════════════
-- BOOST BOSS — BBX MCP-NATIVE EXTENSIONS  (migration 04)
-- Apply with: psql $DATABASE_URL -f db/04_bbx_mcp_extensions.sql
-- Or paste into Supabase → SQL Editor.
--
-- This migration layers MCP-native targeting and inventory onto the v0
-- schema (advertisers / developers / campaigns / events / rtb_*) without
-- touching anything that already ships. Every statement is idempotent
-- and safe to re-run.
--
-- What this migration adds:
--   1. Placement registry        — publishers declare slots inside their
--      apps (chat-inline, tool-result, sidebar, etc.). Today a developer
--      has one implicit "placement" = the whole app; this lets advertisers
--      target a specific surface.
--   2. MCP targeting columns     — campaigns can now bid on intent tokens,
--      active MCP tools, host apps, and surface kinds. Free-form text[]
--      arrays so advertisers aren't blocked on a curated taxonomy.
--   3. Embedding column          — campaigns get a 1536-dim pgvector for
--      cosine-similarity intent matching at bid time (Benna v0 §9).
--   4. Auction-keyed events      — events can now reference auction_id,
--      placement, surface, format, and Benna's intent_match_score so we
--      get clean training data and per-placement reporting.
--   5. Eligibility helper RPC    — a single SQL function that returns
--      candidate campaigns for a bid request. Hot path will read from
--      Redis; this is the cold-path fallback and the source of truth.
--   6. Materialized view         — daily metrics broken down per
--      placement, for the publisher dashboard.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 0. Extensions ────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "vector";     -- pgvector for intent embeddings


-- ── 1. PLACEMENTS — publisher-declared inventory slots ──────────────
-- A "placement" is a specific monetizable slot inside an app. Publishers
-- register them via the dashboard. Each placement has its own format,
-- surface, floor, and frequency-cap policy. A campaign targets placements
-- by (format, surface, host) — no direct placement_id targeting, so
-- advertisers don't have to know publishers' internal IDs.
create table if not exists public.placements (
  id              text primary key
                  default 'plc_' || replace(gen_random_uuid()::text, '-', ''),
  developer_id    uuid not null references public.developers(id) on delete cascade,
  app_id          text not null,                    -- denormalised from developers.app_id
  name            text not null,                    -- "Chat inline default", human-readable
  surface         text not null
                  check (surface in (
                    'chat',          -- inline cards inside chat output
                    'tool_response', -- sponsored result mixed into a tool's response
                    'sidebar',       -- sidebar unit (Cursor, Claude desktop, etc.)
                    'loading_screen',
                    'status_line',
                    'web'            -- generic web surface (legacy site embeds)
                  )),
  format          text not null
                  check (format in ('image','video','native','text_card')),
  floor_cpm       numeric(8,4) not null default 1.50,
  freq_cap_per_user_per_day int not null default 5,
  size_max_chars  int,                               -- format-dependent
  size_max_lines  int,
  size_max_px     int,
  status          text not null default 'active'
                  check (status in ('active','paused','archived')),
  -- which categories the publisher refuses to host (publisher-side brand safety)
  excluded_categories text[] default '{}',
  excluded_advertisers text[] default '{}',
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists placements_developer_idx
  on public.placements(developer_id);
create index if not exists placements_app_idx
  on public.placements(app_id);
create index if not exists placements_surface_format_idx
  on public.placements(surface, format) where status = 'active';


-- ── 2. CAMPAIGNS — MCP-native targeting columns ─────────────────────
-- Each column is added in its own DO block so partial re-runs are safe.

do $$ begin
  -- Free-form intent tokens. The advertiser-side analog of search keywords,
  -- e.g. ['billing_integration','saas','stripe']. We deliberately do NOT
  -- enforce a curated taxonomy in v1 — embedding match handles fuzziness.
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'campaigns' and column_name = 'target_intent_tokens'
  ) then
    alter table public.campaigns
      add column target_intent_tokens text[] default '{}';
  end if;

  -- Active-tool targeting. e.g. ['stripe-mcp','quickbooks-mcp']. Bid only
  -- when the agent has one of these MCP servers connected.
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'campaigns' and column_name = 'target_active_tools'
  ) then
    alter table public.campaigns
      add column target_active_tools text[] default '{}';
  end if;

  -- Host-app targeting. e.g. ['cursor','claude_desktop','vscode'].
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'campaigns' and column_name = 'target_host_apps'
  ) then
    alter table public.campaigns
      add column target_host_apps text[] default '{}';
  end if;

  -- Surface targeting. e.g. ['chat','tool_response']. Empty = any.
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'campaigns' and column_name = 'target_surfaces'
  ) then
    alter table public.campaigns
      add column target_surfaces text[] default '{}';
  end if;

  -- Pre-computed embedding of the campaign's combined targeting tokens.
  -- Refreshed when target_intent_tokens / target_active_tools / target_host_apps
  -- change. Bid path embeds the request's intent_tokens at hot-time and
  -- computes cosine similarity against this column.
  -- 1536 dims = OpenAI text-embedding-3-small. Nullable until first compute.
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'campaigns' and column_name = 'intent_embedding'
  ) then
    alter table public.campaigns
      add column intent_embedding vector(1536);
  end if;
end $$;

-- GIN indexes for array containment / overlap. eligibility() below uses these.
create index if not exists campaigns_intent_tokens_gin
  on public.campaigns using gin(target_intent_tokens);
create index if not exists campaigns_active_tools_gin
  on public.campaigns using gin(target_active_tools);
create index if not exists campaigns_host_apps_gin
  on public.campaigns using gin(target_host_apps);
create index if not exists campaigns_surfaces_gin
  on public.campaigns using gin(target_surfaces);

-- ANN index on the embedding column. Built only after some rows have
-- non-null embeddings (otherwise pgvector errors). We create it
-- conditionally via a DO block so the migration doesn't crash on a fresh DB.
do $$ begin
  if exists (select 1 from public.campaigns where intent_embedding is not null limit 1) then
    if not exists (
      select 1 from pg_indexes
      where schemaname = 'public' and indexname = 'campaigns_intent_embedding_idx'
    ) then
      execute 'create index campaigns_intent_embedding_idx
               on public.campaigns using ivfflat (intent_embedding vector_cosine_ops)
               with (lists = 100)';
    end if;
  end if;
end $$;


-- ── 3. EVENTS — auction-keyed columns ──────────────────────────────
-- Today the events row references campaign + developer. Adding auction_id,
-- placement_id, surface, format, intent_match_score gives us:
--   - per-placement reporting on the publisher dashboard
--   - the (impression, outcome) pairs Benna v1 needs for training
--   - idempotency on (auction_id, event_type) — see §6.3 of the protocol

do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'events' and column_name = 'auction_id'
  ) then
    alter table public.events add column auction_id text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'events' and column_name = 'placement_id'
  ) then
    alter table public.events
      add column placement_id text references public.placements(id) on delete set null;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'events' and column_name = 'surface'
  ) then
    alter table public.events add column surface text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'events' and column_name = 'format'
  ) then
    alter table public.events add column format text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'events' and column_name = 'intent_match_score'
  ) then
    alter table public.events add column intent_match_score numeric(5,4);
  end if;

  -- Idempotency: at most one row per (auction_id, event_type). Allows
  -- nulls today (legacy rows pre-migration) by partial-uniqueness.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'events_auction_type_unique'
  ) then
    execute 'create unique index events_auction_type_unique
             on public.events(auction_id, event_type)
             where auction_id is not null';
  end if;
end $$;

create index if not exists events_placement_idx on public.events(placement_id);
create index if not exists events_surface_idx   on public.events(surface);


-- ── 4. RTB_AUCTIONS — MCP context column ───────────────────────────
-- The OpenRTB BidRequest already carries ext.mcp_context. We materialise
-- it into a typed column so the eligibility() RPC can join against it.
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'rtb_auctions' and column_name = 'mcp_context'
  ) then
    alter table public.rtb_auctions add column mcp_context jsonb;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'rtb_auctions' and column_name = 'placement_id'
  ) then
    alter table public.rtb_auctions add column placement_id text
      references public.placements(id) on delete set null;
  end if;
end $$;

create index if not exists rtb_auctions_placement_idx
  on public.rtb_auctions(placement_id);
create index if not exists rtb_auctions_mcp_intent_gin
  on public.rtb_auctions using gin((mcp_context -> 'intent_tokens'));


-- ── 5. ELIGIBILITY HELPER RPC ──────────────────────────────────────
-- Returns candidate campaigns for a bid request. Used as cold-path
-- fallback when Redis cache misses. Hot path replicates this logic in
-- Redis with pre-computed indexes; this function is the source of truth.
--
-- Filtering rules (in order of selectivity):
--   1. status = 'active'
--   2. format match (campaign format ∈ allowed formats for placement)
--   3. surface match (campaign.target_surfaces empty OR contains placement.surface)
--   4. host match     (campaign.target_host_apps empty OR contains p_host)
--   5. tool match     (campaign.target_active_tools empty OR overlaps p_active_tools)
--   6. geo match      (campaign.target_regions = 'global' OR contains p_country)
--   7. budget remaining (spent_today < daily_budget)
--   8. brand-safety:  campaign.iab_cat NOT overlap placement.excluded_categories
--                AND  campaign.adomain NOT overlap placement.excluded_advertisers
--
-- Returns campaigns ordered by indicative_bid_cpm DESC, capped at p_limit.
-- Pricing (Benna scoring) happens in the caller — this only filters.
create or replace function public.bbx_eligible_campaigns(
  p_placement_id    text,
  p_format          text,
  p_surface         text,
  p_host            text,
  p_country         text,
  p_active_tools    text[],
  p_intent_tokens   text[],            -- not used for filtering, only logging
  p_limit           int default 50
) returns table (
  campaign_id        uuid,
  bid_amount         numeric,
  daily_budget       numeric,
  spent_today        numeric,
  format             text,
  target_intent_tokens text[],
  target_active_tools  text[],
  target_host_apps     text[],
  intent_embedding   vector(1536)
)
language sql stable
as $$
  with placement as (
    select * from public.placements where id = p_placement_id
  )
  select
    c.id,
    c.bid_amount,
    c.daily_budget,
    coalesce(c.spent_today, 0) as spent_today,
    c.format,
    c.target_intent_tokens,
    c.target_active_tools,
    c.target_host_apps,
    c.intent_embedding
  from public.campaigns c
  cross join placement p
  where c.status = 'active'
    and c.format = p_format
    -- surface match
    and (
      coalesce(array_length(c.target_surfaces, 1), 0) = 0
      or p_surface = any(c.target_surfaces)
    )
    -- host match
    and (
      coalesce(array_length(c.target_host_apps, 1), 0) = 0
      or p_host = any(c.target_host_apps)
    )
    -- tool match (overlap)
    and (
      coalesce(array_length(c.target_active_tools, 1), 0) = 0
      or c.target_active_tools && p_active_tools
    )
    -- geo match
    and (
      'global' = any(c.target_regions)
      or p_country = any(c.target_regions)
    )
    -- budget remaining
    and (
      c.daily_budget is null
      or coalesce(c.spent_today, 0) < c.daily_budget
    )
    -- publisher brand-safety: refuse advertiser categories the publisher excluded
    and (
      coalesce(array_length(p.excluded_categories, 1), 0) = 0
      or not (c.iab_cat && p.excluded_categories)
    )
    and (
      coalesce(array_length(p.excluded_advertisers, 1), 0) = 0
      or not (c.adomain && p.excluded_advertisers)
    )
  order by c.bid_amount desc nulls last
  limit greatest(p_limit, 1);
$$;


-- ── 6. PLACEMENT METRICS — daily rollup view ───────────────────────
-- Per-placement-per-day aggregates. Powers the publisher-dashboard's
-- placement-level breakdown. Refresh via cron / pg_cron alongside
-- bbx_aggregate_daily_stats.
create or replace view public.placement_daily_stats as
select
  date_trunc('day', e.created_at)::date              as date,
  e.placement_id,
  e.developer_id,
  e.surface,
  e.format,
  count(*) filter (where e.event_type = 'impression') as impressions,
  count(*) filter (where e.event_type = 'click')      as clicks,
  count(*) filter (where e.event_type = 'video_complete') as video_completes,
  count(*) filter (where e.event_type = 'close')      as closes,
  coalesce(sum(e.cost), 0)             as gross_spend,
  coalesce(sum(e.developer_payout), 0) as publisher_earnings,
  -- eCPM = (gross_spend / impressions) * 1000
  case
    when count(*) filter (where e.event_type = 'impression') = 0 then null
    else (coalesce(sum(e.cost), 0)
          / count(*) filter (where e.event_type = 'impression')) * 1000
  end as ecpm,
  -- CTR
  case
    when count(*) filter (where e.event_type = 'impression') = 0 then null
    else (count(*) filter (where e.event_type = 'click')::numeric
          / count(*) filter (where e.event_type = 'impression'))
  end as ctr,
  avg(e.intent_match_score) filter (where e.intent_match_score is not null)
    as avg_intent_match
from public.events e
where e.placement_id is not null
  and e.created_at >= now() - interval '90 days'
group by 1, 2, 3, 4, 5;


-- ── 7. RLS — placements ────────────────────────────────────────────
alter table public.placements enable row level security;

do $$ begin
  drop policy if exists "Developers manage own placements" on placements;
  create policy "Developers manage own placements"
    on placements for all
    using (developer_id = auth.uid());

  drop policy if exists "Active placements are readable" on placements;
  create policy "Active placements are readable"
    on placements for select
    using (status = 'active');
end $$;

-- Service role bypasses RLS for the auction handler (uses SUPABASE_SERVICE_ROLE_KEY).


-- ── 8. SEED — placements for existing demo developers ──────────────
-- Each demo developer gets two placements so the auction surface has
-- realistic inventory in staging.
insert into public.placements
  (id, developer_id, app_id, name, surface, format, floor_cpm, freq_cap_per_user_per_day)
values
  ('plc_demo001_chat_inline',
   'd0000000-0000-0000-0000-000000000001'::uuid, 'app_demo001',
   'Chat inline (default)', 'chat', 'native', 1.50, 5),
  ('plc_demo001_sidebar',
   'd0000000-0000-0000-0000-000000000001'::uuid, 'app_demo001',
   'Sidebar unit',          'sidebar', 'image', 0.80, 8),
  ('plc_demo002_chat_inline',
   'd0000000-0000-0000-0000-000000000002'::uuid, 'app_demo002',
   'Chat inline (default)', 'chat', 'native', 1.50, 5),
  ('plc_demo002_tool_result',
   'd0000000-0000-0000-0000-000000000002'::uuid, 'app_demo002',
   'Sponsored tool result', 'tool_response', 'native', 2.50, 3)
on conflict (id) do nothing;

-- Backfill MCP targeting on demo campaigns so eligibility() returns
-- something interesting in staging.
update public.campaigns set
  target_intent_tokens = array['landing_page','design','website','no_code'],
  target_host_apps     = array['cursor','claude_desktop','vscode'],
  target_surfaces      = array['chat','sidebar']
where name = 'Framer Landing Pages' and (target_intent_tokens is null or target_intent_tokens = '{}');

update public.campaigns set
  target_intent_tokens = array['deploy','hosting','nextjs','infrastructure'],
  target_active_tools  = array['vercel-mcp','github-mcp'],
  target_host_apps     = array['cursor','claude_desktop','vscode'],
  target_surfaces      = array['chat','tool_response','sidebar']
where name = 'Vercel Deploy' and (target_intent_tokens is null or target_intent_tokens = '{}');

update public.campaigns set
  target_intent_tokens = array['code','programming','debug_py','refactor'],
  target_active_tools  = array['shell-mcp','filesystem-mcp'],
  target_host_apps     = array['cursor','vscode','jetbrains'],
  target_surfaces      = array['chat','sidebar']
where name = 'Cursor AI IDE' and (target_intent_tokens is null or target_intent_tokens = '{}');

update public.campaigns set
  target_intent_tokens = array['notes','docs','wiki','project_management'],
  target_active_tools  = array['notion-mcp'],
  target_host_apps     = array['claude_desktop','cursor'],
  target_surfaces      = array['chat','sidebar']
where name = 'Notion AI Workspace' and (target_intent_tokens is null or target_intent_tokens = '{}');


-- ═══════════════════════════════════════════════════════════════════════
-- Done. Sanity checks:
--   select count(*) from public.placements;           -- expect 4
--   select count(*) from public.campaigns
--    where target_intent_tokens <> '{}';              -- expect 4
--   select * from public.bbx_eligible_campaigns(
--     'plc_demo002_tool_result',
--     'native','tool_response','cursor','US',
--     array['vercel-mcp','github-mcp'],
--     array['deploy','hosting'],
--     50);
-- ═══════════════════════════════════════════════════════════════════════
