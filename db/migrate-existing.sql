-- ═══════════════════════════════════════════════════════════════════════
-- BOOST BOSS — MIGRATION FOR EXISTING SUPABASE INSTANCE
-- Run this BEFORE deploy.sql if your tables already exist.
-- Safely adds columns that were introduced in waves 1-4.
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

-- ── Advertisers: add stripe_customer_id ────────────────────────────────
DO $$ BEGIN
  ALTER TABLE public.advertisers ADD COLUMN stripe_customer_id text;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ── Developers: add publisher_domain, stripe_account_id, revenue_share_pct ─
DO $$ BEGIN
  ALTER TABLE public.developers ADD COLUMN publisher_domain text;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.developers ADD COLUMN stripe_account_id text;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.developers ADD COLUMN revenue_share_pct numeric(5,2) DEFAULT 85.00;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ── Campaigns: add adomain, iab_cat, target_cpa, billing_model, skippable_after_sec ─
DO $$ BEGIN
  ALTER TABLE public.campaigns ADD COLUMN adomain text[] DEFAULT '{}';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.campaigns ADD COLUMN iab_cat text[] DEFAULT '{}';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.campaigns ADD COLUMN target_cpa numeric(8,2);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.campaigns ADD COLUMN billing_model text DEFAULT 'cpm';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.campaigns ADD COLUMN skippable_after_sec int DEFAULT 3;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.campaigns ADD COLUMN poster_url text;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ── Events: add developer_id, cost, developer_payout, geo columns ─────
DO $$ BEGIN
  ALTER TABLE public.events ADD COLUMN developer_id uuid REFERENCES public.developers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.events ADD COLUMN ip_country text DEFAULT 'unknown';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.events ADD COLUMN ip_region text DEFAULT 'unknown';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.events ADD COLUMN ip_city text DEFAULT 'unknown';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.events ADD COLUMN user_language text DEFAULT 'en';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.events ADD COLUMN user_agent text;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.events ADD COLUMN cost numeric(8,4) DEFAULT 0.00;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.events ADD COLUMN developer_payout numeric(8,4) DEFAULT 0.00;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ── Update revenue_share from 65% to 85% if it was set to old default ──
UPDATE public.developers SET revenue_share_pct = 85.00 WHERE revenue_share_pct = 65.00;

-- ═══════════════════════════════════════════════════════════════════════
-- Done. Now run deploy.sql — the CREATE TABLE IF NOT EXISTS will be
-- skipped (tables exist), but all the new columns are in place so the
-- seed data, indexes, RLS, and RPCs will apply cleanly.
-- ═══════════════════════════════════════════════════════════════════════
