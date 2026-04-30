-- ───────────────────────────────────────────────────────────────────────
-- 06_integration_method.sql
-- Bank the per-request integration source so the publisher dashboard can
-- slice impressions/clicks/revenue by which integration method the
-- request came through (mcp / js-snippet / npm-sdk / rest-api).
--
-- Cheap to add now, expensive to retrofit. Filterable in dashboard UI.
-- Apply via Supabase SQL Editor → run the whole file. Idempotent.
-- ───────────────────────────────────────────────────────────────────────

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS integration_method TEXT;

-- Backfill existing rows: assume any pre-tag rows came from MCP since
-- that's the only integration that's been live.
UPDATE events
   SET integration_method = 'mcp'
 WHERE integration_method IS NULL
   AND created_at < NOW();

-- Index for dashboard slicing. Partial — only indexes rows that have
-- a value, which is all of them post-backfill but keeps the index lean
-- if a future code path ever inserts without tagging.
CREATE INDEX IF NOT EXISTS events_integration_method_created_idx
  ON events(integration_method, created_at DESC)
  WHERE integration_method IS NOT NULL;

-- Light constraint: only allow the four planned values + NULL.
-- Drop the constraint first if it exists so re-running this file
-- updates the allowed set cleanly.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_integration_method_chk;
ALTER TABLE events
  ADD CONSTRAINT events_integration_method_chk
  CHECK (integration_method IS NULL
      OR integration_method IN ('mcp', 'js-snippet', 'npm-sdk', 'rest-api'));
