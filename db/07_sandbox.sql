-- ───────────────────────────────────────────────────────────────────────
-- 07_sandbox.sql
-- Tag sandbox-mode events on the events table so dashboard queries can
-- exclude test traffic from real reporting.
--
-- Sandbox mode is triggered when /api/mcp receives a credential with the
-- pub_test_* or sk_test_* prefix. /api/_lib/sandbox.js short-circuits the
-- auction and returns a fixed creative from a small rotation pool. The
-- tracking URLs include &sandbox=1 so /api/track sets is_sandbox=true on
-- the event row and skips cost computation / budget deduction entirely.
--
-- Apply via Supabase SQL Editor → run the whole file. Idempotent.
-- ───────────────────────────────────────────────────────────────────────

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index — only the production rows. Dashboard queries that
-- filter `WHERE is_sandbox = false` use this; sandbox-only queries
-- (e.g., for debugging publishers' integration tests) skip it.
CREATE INDEX IF NOT EXISTS events_production_created_idx
  ON events(created_at DESC)
  WHERE is_sandbox = FALSE;

-- Convenience view: production-only events. Use this in any dashboard
-- query that should exclude sandbox traffic from real metrics. Existing
-- queries that hit `events` directly continue to work; opt-in.
CREATE OR REPLACE VIEW events_production AS
  SELECT * FROM events WHERE is_sandbox = FALSE;
