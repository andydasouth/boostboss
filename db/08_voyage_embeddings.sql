-- ═══════════════════════════════════════════════════════════════════════
-- BOOST BOSS — VOYAGE AI EMBEDDINGS  (migration 08)
-- Apply with: psql $DATABASE_URL -f db/08_voyage_embeddings.sql
-- Or paste into Supabase → SQL Editor.
--
-- Swaps the embedding provider from OpenAI text-embedding-3-small (1536 dims)
-- to Voyage AI voyage-3-lite (512 dims). Voyage is Anthropic's recommended
-- embedding provider — same per-token cost, smaller storage footprint,
-- comparable or better retrieval quality on short token sets.
--
-- Why drop instead of ALTER:
--   pgvector doesn't allow changing a vector column's dimension via ALTER.
--   The old vector(1536) column was added but never populated (no advertiser
--   ran handleCreate with OPENAI_API_KEY set), so dropping it loses nothing.
--   The cache and miss tables were also added but unused. Safe.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Re-spec campaigns.intent_embedding at 512 dims ──
do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'campaigns' and column_name = 'intent_embedding'
  ) then
    -- Dropping the embedding-specific ANN index first so the column drop
    -- doesn't ripple. Index is created lazily and may not exist.
    if exists (
      select 1 from pg_indexes
      where schemaname = 'public' and indexname = 'campaigns_intent_embedding_idx'
    ) then
      drop index public.campaigns_intent_embedding_idx;
    end if;
    alter table public.campaigns drop column intent_embedding;
  end if;
end $$;

alter table public.campaigns add column intent_embedding vector(512);

-- ── 2. Recreate the per-token cache at 512 dims ──
drop table if exists public.intent_embedding_cache cascade;
drop table if exists public.intent_embedding_misses cascade;

create table public.intent_embedding_cache (
  token         text primary key,
  embedding     vector(512) not null,
  hit_count     bigint not null default 0,
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index intent_embedding_cache_seen_idx
  on public.intent_embedding_cache(last_seen_at desc);

create table public.intent_embedding_misses (
  token        text primary key,
  miss_count   bigint not null default 1,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);

create index intent_embedding_misses_count_idx
  on public.intent_embedding_misses(miss_count desc, last_seen desc);

-- ── 3. Re-create the SQL helpers (cascade drop in §2 removed them) ──
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
  delete from public.intent_embedding_misses
   where token = any(p_tokens);
  return inserted;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- Sanity:
--   select column_name, udt_name from information_schema.columns
--    where table_name='campaigns' and column_name='intent_embedding';
--   -- expect: intent_embedding | vector
--
--   select count(*) from intent_embedding_cache;     -- 0 fresh
--   select count(*) from intent_embedding_misses;    -- 0 fresh
-- ═══════════════════════════════════════════════════════════════════════
