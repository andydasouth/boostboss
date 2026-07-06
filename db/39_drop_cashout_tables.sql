-- ═══════════════════════════════════════════════════════════════════════
-- BOOST BOSS — Drop cash-out + MoR/affiliate tables   (migration 39)
-- Run in Supabase → SQL Editor. Idempotent.
--
-- 2026-07-06 model change: NO cash payouts, ever. Publishers earn CREDITS
-- only (spendable on promoting their own product). Devs who don't host ads
-- pay cash IN. Boost Boss is the only side that takes money.
-- The MoR storefront + affiliate program is retired with it.
--
-- KEEP (do not drop — still load-bearing under the credits model):
--   • advertiser_payouts   — misleading name; it is the earnings→ad-credit
--                            ledger used by the campaigns.js credit-funding gate
--   • payout_clawbacks     — written by the kept pay-in REFUND path
--   • publisher_balance    — credit accrual (incl. lifetime_paid history)
--   • RPCs bbx_credit / decrement_publisher_balance
-- ═══════════════════════════════════════════════════════════════════════

-- Cash-out machinery
drop table if exists public.payout_requests;
drop table if exists public.payouts;
drop table if exists public.publisher_payout_methods;

-- Stripe Connect payout columns on developers
alter table public.developers drop column if exists payouts_enabled;
alter table public.developers drop column if exists payout_blocked;
alter table public.developers drop column if exists payout_blocked_reason;
alter table public.developers drop column if exists payout_blocked_at;
alter table public.developers drop column if exists instant_payouts_enabled;
alter table public.developers drop column if exists stripe_requirements_due;
alter table public.developers drop column if exists stripe_account_id;

-- MoR storefront + affiliate program (CASCADE: interdependent FKs, e.g.
-- vouchers.transaction_id → storefront_transactions; whole domain is retired)
drop table if exists public.vouchers cascade;
drop table if exists public.storefront_transactions cascade;
drop table if exists public.paypal_transactions cascade;
drop table if exists public.affiliate_saved_ads cascade;
drop table if exists public.affiliate_share_links cascade;
drop table if exists public.affiliates cascade;
drop table if exists public.pricing_plans cascade;
drop table if exists public.product_orders cascade;
