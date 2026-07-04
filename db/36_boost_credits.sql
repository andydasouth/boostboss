-- ═══════════════════════════════════════════════════════════════════════
-- BOOST BOSS — BOOST CREDITS  (free launch network economy)  migration 36
-- Run in Supabase SQL Editor. Idempotent.
--
-- The pivot's currency. Impression-denominated ("Boosts"):
--   • +1 Boost minted to the HOST account for every verified, non-sandbox
--     impression its surface serves — even free (credit-funded) ads. This is
--     the "show one, get one shown" reciprocity.
--   • −1 Boost spent per impression of your OWN promotion (wired in a later
--     increment via campaigns funding).
--   • Starter grant on signup, and cash→Boost purchases, are also ledger rows.
--   • ONE-WAY: cash can buy Boosts; Boosts never convert to cash.
--
-- Ledger design (append-only): balance = SUM(delta) per account_id.
-- account_id is the auth.users id (advertiser_id == developer_id once accounts
-- merge; today either works since both FK auth.users).
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.boost_credit_ledger (
  id          bigint generated always as identity primary key,
  account_id  uuid not null,                 -- auth.users(id)
  delta       integer not null,              -- +earned / −spent, in impressions (Boosts)
  reason      text not null,                 -- serve | starter_grant | cash_purchase | promote_spend | adjust
  ref         text,                          -- auction_id / campaign_id / payment id (dedupe key for 'serve')
  created_at  timestamptz not null default now()
);

create index if not exists boost_credit_ledger_account_idx
  on public.boost_credit_ledger (account_id, created_at desc);

-- One 'serve' mint per (account, auction) so a retried impression beacon
-- can never double-mint. Insert conflicts are swallowed by the helper.
create unique index if not exists boost_credit_ledger_serve_uniq
  on public.boost_credit_ledger (account_id, ref) where reason = 'serve';

-- Server-only (service role); enable RLS with no anon policies.
alter table public.boost_credit_ledger enable row level security;

-- Convenience: current balance per account.
create or replace view public.boost_credit_balances as
  select account_id, coalesce(sum(delta), 0)::bigint as boosts
  from public.boost_credit_ledger group by account_id;
