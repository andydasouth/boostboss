-- ───────────────────────────────────────────────────────────────────────
-- 09_target_integration_methods.sql
-- Per-campaign opt-in to specific publisher integration doors.
--
-- Column values match the X-Lumi-Source header taxonomy that publisher
-- SDKs send on every request, and that db/06_integration_method.sql
-- already tags onto the events table:
--   mcp        — Lumi SDK for MCP (Claude Desktop, Cursor, Cline)
--   js-snippet — Lumi SDK script tag (web AI apps)
--   npm-sdk    — Lumi SDK for browser extensions (Chrome / Edge / Firefox)
--   rest-api   — Lumi API for Bots (Discord, Telegram, Slack)
--
-- Empty array means "all doors" — back-compat for every existing campaign.
-- The auction filter in api/mcp.js excludes a campaign when its
-- target_integration_methods is non-empty and the request's
-- integration_method is not in the list.
--
-- The OpenRTB path (api/rtb.js) does not enforce this filter — external
-- DSP traffic doesn't carry door provenance, and excluding it silently
-- would drop existing rtb campaigns. Document, don't enforce.
--
-- Apply via Supabase SQL Editor → run the whole file. Idempotent.
-- ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS target_integration_methods text[] NOT NULL DEFAULT '{}';

-- GIN index — supports the auction's "request integration_method ∈
-- campaign target_integration_methods" predicate cheaply.
CREATE INDEX IF NOT EXISTS idx_campaigns_target_integration_methods
  ON public.campaigns USING gin(target_integration_methods);

-- Light constraint: values must be in the four-door allowlist (or empty).
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_target_integration_methods_chk;
ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_target_integration_methods_chk
  CHECK (
    target_integration_methods <@ ARRAY['mcp', 'js-snippet', 'npm-sdk', 'rest-api']::text[]
  );
