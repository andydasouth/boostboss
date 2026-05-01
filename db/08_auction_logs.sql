-- ───────────────────────────────────────────────────────────────────────
-- 08_auction_logs.sql
-- Per-auction structured log: one row per get_sponsored_content (mcp.js)
-- or per OpenRTB bid request (rtb.js). Captures the request, eligibility
-- breakdown, scored candidates with components, and outcome.
--
-- Rationale: when something looks wrong on the dashboard ("why didn't my
-- campaign serve here?"), we need ground-truth replay data — what did the
-- request look like, which campaigns were eligible, what did Benna score
-- them, which one won. No UI yet — just queryable rows.
--
-- Retention: 30 days via bbx_prune_auction_logs() (call from pg_cron).
-- Apply via Supabase SQL Editor → run the whole file. Idempotent.
-- ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.auction_logs (
  auction_id          text PRIMARY KEY,
  ts                  timestamptz NOT NULL DEFAULT now(),

  -- Which auction surface produced this log
  surface             text NOT NULL CHECK (surface IN ('mcp', 'rtb')),

  -- Publisher (denormalized for cheap filters in the dashboard)
  publisher_id        uuid REFERENCES public.developers(id) ON DELETE SET NULL,
  publisher_domain    text,
  integration_method  text CHECK (integration_method IS NULL
                            OR integration_method IN ('mcp', 'js-snippet', 'npm-sdk', 'rest-api')),
  is_sandbox          boolean NOT NULL DEFAULT false,

  -- Request fingerprint — what came in. Includes (where present):
  --   host, host_app, surface, intent_tokens[], active_tools[], country,
  --   format_preference, context_summary (truncated to 500 chars),
  --   session_id_hash (for rate-limit debugging without PII).
  request             jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Eligibility breakdown — counts of campaigns kept after each filter.
  --   {
  --     pool_size:        N,   -- starting pool
  --     after_status:     N,   -- only active campaigns
  --     after_region:     N,   -- target_regions match
  --     after_lang:       N,   -- target_languages match
  --     after_format:     N,   -- placement format gate + publisher format toggle
  --     after_blocklist:  N,   -- iab_cat / adomain blocklist
  --     after_mcp:        N,   -- mcpTargetingMatch (surface/host_app/active_tools)
  --     after_floor:      N,   -- cleared the placement floor
  --     eligible_final:   N,   -- final scored count
  --     drop_reasons:     {region:N, lang:N, format:N, ...}  -- per-stage drop counts
  --   }
  eligibility         jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Top-N scored candidates (capped at 10 to keep row size sane).
  -- Each entry: { campaign_id, campaign_name, p_click, p_convert,
  --               signal_contributions[], price_cpm, factors,
  --               kw_boost, effective_price_cpm, self_promote, won }
  candidates          jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Outcome
  winner_campaign_id  text,
  winning_price_cpm   numeric(12,4),
  outcome             text NOT NULL CHECK (outcome IN
                        ('won', 'no_match', 'below_floor',
                         'rate_limited', 'sandbox', 'error')),
  no_fill_reason      text,
  latency_ms          numeric(8,2),

  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Indices for the queries we expect: by recency, by publisher, by outcome
CREATE INDEX IF NOT EXISTS idx_auction_logs_ts
  ON public.auction_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_auction_logs_publisher_ts
  ON public.auction_logs(publisher_id, ts DESC)
  WHERE publisher_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auction_logs_outcome_ts
  ON public.auction_logs(outcome, ts DESC);
CREATE INDEX IF NOT EXISTS idx_auction_logs_integration_method_ts
  ON public.auction_logs(integration_method, ts DESC)
  WHERE integration_method IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auction_logs_winner_ts
  ON public.auction_logs(winner_campaign_id, ts DESC)
  WHERE winner_campaign_id IS NOT NULL;

-- ── 30-day retention via cleanup function ─────────────────────────────
-- Call manually from Supabase or schedule via pg_cron. Returns the row
-- count that was deleted so the operator can confirm pruning is working.
CREATE OR REPLACE FUNCTION public.bbx_prune_auction_logs()
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  deleted int;
  cutoff  timestamptz := now() - interval '30 days';
BEGIN
  DELETE FROM public.auction_logs WHERE ts < cutoff;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN jsonb_build_object(
    'deleted', deleted,
    'cutoff',  cutoff,
    'pruned_at', now()
  );
END $$;

-- Schedule via pg_cron once enabled in the project:
--   select cron.schedule('bbx-prune-auction-logs', '0 4 * * *',
--          $$ select public.bbx_prune_auction_logs() $$);

-- ── RLS: server-only writes (service_role bypasses) ───────────────────
ALTER TABLE public.auction_logs ENABLE ROW LEVEL SECURITY;
-- No anon policy — only service_role inserts/reads. If we later expose a
-- "your auctions" view to publishers, add a SELECT policy keyed on
-- publisher_id = auth.uid().
