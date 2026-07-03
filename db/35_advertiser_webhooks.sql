-- ═══════════════════════════════════════════════════════════════════════
-- BOOST BOSS — advertiser webhooks (event push for the demand-side harness)
-- Run in Supabase SQL Editor. Idempotent.
--
-- Backs api/webhooks.js (registration/CRUD) + api/_lib/webhook_delivery.js
-- (HMAC-signed delivery). Advertisers register a URL + a set of events; when
-- those events fire (campaign.approved, campaign.rejected, campaign.created,
-- campaign.paused, campaign.resumed, …) Boost Boss POSTs a signed payload.
-- Secrets are stored server-side only; service_role (the API) is the sole
-- reader/writer — RLS on, no anon/authenticated policies.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.advertiser_webhooks (
  id                uuid primary key default gen_random_uuid(),
  advertiser_id     uuid not null references public.advertisers(id) on delete cascade,
  name              text,
  url               text not null,
  secret            text not null,                    -- whsec_… (HMAC key)
  events            text[] not null default '{}'::text[],  -- ['campaign.approved', …] or ['*']
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  last_delivery_at  timestamptz,
  last_status       int
);

alter table public.advertiser_webhooks add column if not exists name             text;
alter table public.advertiser_webhooks add column if not exists last_delivery_at timestamptz;
alter table public.advertiser_webhooks add column if not exists last_status      int;

create index if not exists advertiser_webhooks_adv_idx
  on public.advertiser_webhooks (advertiser_id);
create index if not exists advertiser_webhooks_active_idx
  on public.advertiser_webhooks (advertiser_id, active) where active = true;

-- Server-only. The API uses the service role (bypasses RLS); enabling RLS
-- with no policies means anon/authenticated clients can never read secrets.
alter table public.advertiser_webhooks enable row level security;
