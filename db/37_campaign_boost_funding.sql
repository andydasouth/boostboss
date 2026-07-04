-- ═══════════════════════════════════════════════════════════════════════
-- BOOST BOSS — Boost-funded campaigns  (free launch network)  migration 37
-- Run in Supabase SQL Editor. Idempotent. Depends on db/36 (boost_credit_ledger).
--
-- A Boost-funded campaign is a FREE promotion: it spends 1 Boost per impression
-- (debited at serve time from the promoter), never cash. It's stamped
-- credit_funded=true so the auction ranks it below cash-funded promotions.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.campaigns add column if not exists boost_funded boolean not null default false;
alter table public.campaigns add column if not exists boost_budget integer;            -- total Boosts (impressions) to spend; null = spend until balance empty
alter table public.campaigns add column if not exists boost_spent  integer not null default 0;

-- One starter grant per account (enforced at the ledger level).
create unique index if not exists boost_credit_ledger_starter_uniq
  on public.boost_credit_ledger (account_id) where reason = 'starter_grant';
