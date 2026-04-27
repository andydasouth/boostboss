-- ═══════════════════════════════════════════════════════════════════════
-- BOOST BOSS — PER-TOKEN EMBEDDING CACHE  (migration 07)
-- Apply with: psql $DATABASE_URL -f db/07_embedding_cache.sql
-- Or paste into Supabase → SQL Editor.
--
-- Stage 1 of the AppLovin-scale auction path: take OpenAI off the bid
-- hot path entirely. Approach is per-token caching with vector averaging
-- at bid time — at MCP-ads scale, ~10k unique tokens cover 99% of intent
-- contexts because they recombine endlessly. Embed each token once
-- ($4e-7), then any future combination of cached tokens is free.
--
-- What this migration adds:
--   1. intent_embedding_cache    — one row per token, holds the 1536-dim vector
--   2. intent_embedding_misses   — queue of tokens seen at bid time but not
--                                    yet embedded. The /api/embed-cron job
--                                    drains this every N minutes.
--   3. bbx_log_embedding_misses(text[]) — atomic upsert for queueing misses
-- All statements idempotent.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Per-token cache ──
create table if not exists public.intent_embedding_cache (
  token         text primary key,
  embedding     vector(1536) not null,
  hit_count     bigint not null default 0,
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- Reverse-chronological so the cron job can warm hot tokens first.
create index if not exists intent_embedding_cache_seen_idx
  on public.intent_embedding_cache(last_seen_at desc);

-- ── 2. Miss queue ──
-- Tokens seen by /api/mcp at bid time that aren't in the cache yet. The
-- cron job drains this in batches of N. Composite PK lets us upsert
-- without checking existence first — multiple bid requests can log the
-- same miss concurrently and we just bump miss_count.
create table if not exists public.intent_embedding_misses (
  token        text primary key,
  miss_count   bigint not null default 1,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);

create index if not exists intent_embedding_misses_count_idx
  on public.intent_embedding_misses(miss_count desc, last_seen desc);

-- ── 3. Atomic miss-logger RPC ──
-- Called from the bid path on cache miss. Bulk upserts an array of
-- tokens, bumping miss_count on conflict. Returns void; caller doesn't
-- need confirmation since it's fire-and-forget.
create or replace function public.bbx_log_embedding_misses(p_tokens text[])
returns void
language sql
as $$
  insert into public.intent_embedding_misses (token, miss_count, first_seen, last_seen)
  select t, 1, now(), now() from unnest(p_tokens) as t
   where t is not null and length(t) between 1 and 64
  on conflict (token) do update
    set miss_count = public.intent_embedding_misses.miss_count + 1,
        last_seen  = now();
$$;

-- ── 4. Cache promote RPC ──
-- The cron job calls this with (tokens, vectors) after batch-embedding;
-- single round-trip vs. N upserts. Also bumps hit_count on existing rows
-- so we can age out cold ones later.
create or replace function public.bbx_promote_embeddings(
  p_tokens     text[],
  p_embeddings text[]
) returns int
language plpgsql
as $$
declare
  i int;
  inserted int := 0;
begin
  if array_length(p_tokens, 1) is null then return 0; end if;
  for i in 1 .. array_length(p_tokens, 1) loop
    insert into public.intent_embedding_cache (token, embedding, last_seen_at)
    values (p_tokens[i], p_embeddings[i]::vector, now())
    on conflict (token) do update
      set embedding    = excluded.embedding,
          last_seen_at = now(),
          hit_count    = public.intent_embedding_cache.hit_count + 1;
    inserted := inserted + 1;
  end loop;
  -- Clear corresponding misses so the next cron run doesn't re-process.
  delete from public.intent_embedding_misses
   where token = any(p_tokens);
  return inserted;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- Sanity:
--   select count(*) from intent_embedding_cache;       -- 0 fresh, grows over time
--   select count(*) from intent_embedding_misses;      -- 0 fresh
--   select bbx_log_embedding_misses(array['stripe','billing']);
--   select * from intent_embedding_misses;             -- 2 rows
-- ═══════════════════════════════════════════════════════════════════════
