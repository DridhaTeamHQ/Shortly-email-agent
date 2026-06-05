-- RAG self-learning layer.
-- Adds pgvector, per-article embedding + advisory selection score, an HNSW index,
-- a similarity-search RPC, and a small key/value config table (used to swap the
-- summarization model after a gated fine-tune). All statements are idempotent.

-- 1. Vector extension
create extension if not exists vector;

-- 2. New columns on articles
alter table public.articles add column if not exists embedding vector(1536);
alter table public.articles add column if not exists suggestion_score numeric;
alter table public.articles add column if not exists suggestion_meta jsonb;
-- prominence is written by summarize-articles but was never in the schema (latent bug). No-op if it already exists live.
alter table public.articles add column if not exists prominence int;

-- 3. ANN index for cosine similarity (HNSW is robust on small corpora; no list tuning)
create index if not exists articles_embedding_idx
  on public.articles using hnsw (embedding vector_cosine_ops);

-- 4. Similarity search over LABELLED (reviewed) articles only.
--    want_edited => restrict to rows an editor rewrote (style examples).
--    exclude_id  => skip the query article itself.
create or replace function public.match_articles(
  query_embedding vector(1536),
  match_count int,
  want_edited boolean,
  exclude_id uuid
)
returns table (
  id uuid,
  title text,
  edited_title text,
  summary text,
  edited_summary text,
  section text,
  status text,
  similarity float
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id,
    a.title,
    a.edited_title,
    a.summary,
    a.edited_summary,
    a.section,
    a.status,
    1 - (a.embedding <=> query_embedding) as similarity
  from public.articles a
  where a.embedding is not null
    and a.status in ('approved', 'sent', 'rejected')
    and (exclude_id is null or a.id <> exclude_id)
    and (not want_edited or a.edited_title is not null or a.edited_summary is not null)
  order by a.embedding <=> query_embedding
  limit match_count
$$;

-- 5. Key/value config (e.g. OPENAI_MODEL override after a promoted fine-tune)
create table if not exists public.app_config (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;

drop policy if exists "Service role can manage app_config" on public.app_config;
create policy "Service role can manage app_config"
  on public.app_config for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
