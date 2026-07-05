-- ═══════════════════════════════════════════════════════════════════════
-- BOOST BOSS — Notifications feed   (migration 38)
-- Run in Supabase → SQL Editor. Idempotent.
--
-- The in-app notification FEED (distinct from db/17 notification PREFERENCES).
-- One row per notification per account. read_at NULL = unread. The console's
-- topbar bell + the /console#/notifications page both read from here, and
-- api/_lib/notify.js inserts a row when a real event fires (Credits earned,
-- payout sent, SDK connected, welcome, ...).
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null,
  kind        text,                              -- 'welcome' | 'credits' | 'payout' | 'sdk' | 'clicks' | ...
  icon        text,                              -- emoji shown in the feed
  title       text not null,
  body        text,
  created_at  timestamptz not null default now(),
  read_at     timestamptz                        -- NULL = unread
);

create index if not exists notifications_account_created_idx
  on public.notifications (account_id, created_at desc);

-- Dedupe guard for one-time notifications (welcome, first-sdk, ...): a given
-- account gets at most one row per (account_id, kind) when kind is flagged
-- unique by the inserting code via ref. Kept loose here — the app dedupes.
