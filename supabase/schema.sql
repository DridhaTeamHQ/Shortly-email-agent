-- Shortly AI Emailer schema
-- Subscribers, articles (with QA workflow), per-recipient delivery log, and daily digest log.

create table if not exists public.subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  full_name text,
  status text not null default 'subscribed' check (status in ('subscribed', 'unsubscribed', 'bounced')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Articles flow: pending -> summarized -> approved | rejected -> sent
create table if not exists public.articles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  url text not null unique,
  raw_content text,
  summary text,
  edited_title text,
  edited_summary text,
  source text,
  topic text,
  section text check (section in ('wrapped', 'ahead')),
  note text,
  status text not null default 'pending'
    check (status in ('pending', 'summarized', 'approved', 'rejected', 'sent')),
  rank_score numeric default 0,
  scraped_at timestamptz not null default now(),
  summarized_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists articles_status_idx on public.articles (status, scraped_at desc);
create index if not exists articles_rank_idx on public.articles (rank_score desc);

-- Per-subscriber delivery log
create table if not exists public.article_deliveries (
  id uuid primary key default gen_random_uuid(),
  article_id uuid references public.articles(id) on delete cascade,
  digest_id uuid,
  subscriber_id uuid references public.subscribers(id) on delete set null,
  email text not null,
  status text not null check (status in ('sent', 'failed')),
  provider_message_id text,
  error text,
  created_at timestamptz not null default now()
);

-- Daily digest log (one row per digest send)
create table if not exists public.digests (
  id uuid primary key default gen_random_uuid(),
  sent_at timestamptz not null default now(),
  article_ids uuid[] not null,
  recipients int not null default 0,
  sent int not null default 0,
  failed int not null default 0
);

alter table public.subscribers enable row level security;
alter table public.articles enable row level security;
alter table public.article_deliveries enable row level security;
alter table public.digests enable row level security;

create policy "Service role can manage subscribers"
  on public.subscribers for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Service role can manage articles"
  on public.articles for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Service role can manage article deliveries"
  on public.article_deliveries for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Service role can manage digests"
  on public.digests for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- RAG self-learning layer (see migrations/20260605_add_rag_layer.sql).
create extension if not exists vector;

alter table public.articles add column if not exists embedding vector(1536);
alter table public.articles add column if not exists suggestion_score numeric;
alter table public.articles add column if not exists suggestion_meta jsonb;
alter table public.articles add column if not exists prominence int;

create index if not exists articles_embedding_idx
  on public.articles using hnsw (embedding vector_cosine_ops);

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
    a.id, a.title, a.edited_title, a.summary, a.edited_summary, a.section, a.status,
    1 - (a.embedding <=> query_embedding) as similarity
  from public.articles a
  where a.embedding is not null
    and a.status in ('approved', 'sent', 'rejected')
    and (exclude_id is null or a.id <> exclude_id)
    and (not want_edited or a.edited_title is not null or a.edited_summary is not null)
  order by a.embedding <=> query_embedding
  limit match_count
$$;

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
