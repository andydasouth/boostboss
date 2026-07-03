-- ═══════════════════════════════════════════════════════════════════════
-- BOOST BOSS — creative_assets column-drift guard
-- Run in Supabase SQL Editor. Fully idempotent + zero-risk: every statement
-- is `add column if not exists`, so it does NOTHING if the column already
-- exists and only backfills anything a long-ago db/33 run predates.
--
-- Why: db/33 creates the table with `create table if not exists`, which does
-- not add new columns to an already-existing table. If the schema grew after
-- your original run, PATCH /api/creative-assets would silently fail for the
-- missing fields (PGRST204 unknown column) and advertisers couldn't save
-- those creatives. This guarantees the live table matches the code.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.creative_assets add column if not exists brand_name            text;
alter table public.creative_assets add column if not exists brand_logo_url         text;
alter table public.creative_assets add column if not exists brand_favicon_url      text;
alter table public.creative_assets add column if not exists brand_color            text;
alter table public.creative_assets add column if not exists brand_domain           text;

alter table public.creative_assets add column if not exists headlines_short        text[] default '{}'::text[];
alter table public.creative_assets add column if not exists headlines_medium       text[] default '{}'::text[];
alter table public.creative_assets add column if not exists headlines_long         text[] default '{}'::text[];

alter table public.creative_assets add column if not exists body_short             text[] default '{}'::text[];
alter table public.creative_assets add column if not exists body_medium            text[] default '{}'::text[];
alter table public.creative_assets add column if not exists body_long              text[] default '{}'::text[];

alter table public.creative_assets add column if not exists cta_labels             text[] default '{}'::text[];

alter table public.creative_assets add column if not exists images_16_9            text[] default '{}'::text[];
alter table public.creative_assets add column if not exists images_9_16            text[] default '{}'::text[];
alter table public.creative_assets add column if not exists images_3_1             text[] default '{}'::text[];
alter table public.creative_assets add column if not exists images_2_1             text[] default '{}'::text[];

alter table public.creative_assets add column if not exists video_landscape_url    text;
alter table public.creative_assets add column if not exists video_portrait_url     text;
alter table public.creative_assets add column if not exists video_poster_url       text;

alter table public.creative_assets add column if not exists voucher_value_text     text;
alter table public.creative_assets add column if not exists voucher_code           text;
alter table public.creative_assets add column if not exists voucher_redemption_url text;

alter table public.creative_assets add column if not exists library_ready          boolean default false;

-- Verify: this should return all 24 data columns present.
-- select column_name from information_schema.columns
--   where table_schema='public' and table_name='creative_assets' order by 1;
