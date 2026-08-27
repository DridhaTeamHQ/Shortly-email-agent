-- Shortly AI Emailer schema
-- Subscribers, articles (with QA workflow), per-recipient delivery log, and daily digest log.

create table if not exists public.subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  full_name text,
  phone_number text,
  topics text[] not null default array['daily-wrap']::text[],
  status text not null default 'subscribed' check (status in ('subscribed', 'unsubscribed', 'bounced')),
  unsubscribed_at timestamptz,
  welcome_sent_at timestamptz,
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
  category text,
  section text check (section in ('wrapped', 'ahead')),
  note text,
  status text not null default 'pending'
    check (status in ('pending', 'summarized', 'approved', 'rejected', 'sent')),
  rank_score numeric default 0,
  fact_score numeric,
  fact_label text,
  fact_notes jsonb,
  versions jsonb,
  scraped_at timestamptz not null default now(),
  summarized_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists articles_status_idx on public.articles (status, scraped_at desc);
create index if not exists articles_rank_idx on public.articles (rank_score desc);
create index if not exists articles_category_status_idx on public.articles (category, status, scraped_at desc);

create table if not exists public.corporate_cases (
  id uuid primary key default gen_random_uuid(),
  source_url text not null unique,
  source_title text not null,
  source text not null,
  company text,
  headline text not null,
  case_type text not null check (case_type in ('listed', 'startup', 'consumer', 'failure', 'compounder')),
  summary text not null,
  detail text not null,
  comparison_or_analogy text,
  bull_case text,
  bear_case text,
  open_question text,
  inference_notes jsonb not null default '[]'::jsonb,
  editor_checklist jsonb not null default '[]'::jsonb,
  selection_reason text,
  source_excerpt text,
  source_published_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected', 'published')),
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists corporate_cases_status_idx on public.corporate_cases (status, generated_at desc);

create table if not exists public.editorial_drafts (
  id uuid primary key default gen_random_uuid(),
  topic_slug text not null check (topic_slug in ('real-estate', 'policy-partner', 'money-matters', 'wellness-daily')),
  topic_name text not null,
  format text not null check (format in ('single', 'hybrid')),
  headline text not null,
  summary text not null,
  detail text not null,
  briefing_items jsonb not null default '[]'::jsonb,
  content jsonb not null default '{}'::jsonb,
  source_links jsonb not null default '[]'::jsonb,
  primary_source_url text not null,
  primary_source_title text,
  editor_checklist jsonb not null default '[]'::jsonb,
  inference_notes jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected', 'published')),
  fact_score numeric,
  fact_label text,
  fact_notes jsonb,
  versions jsonb,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists editorial_drafts_topic_idx on public.editorial_drafts (topic_slug, generated_at desc);

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
alter table public.corporate_cases enable row level security;
alter table public.editorial_drafts enable row level security;
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

create policy "Service role can manage corporate cases"
  on public.corporate_cases for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Service role can manage editorial drafts"
  on public.editorial_drafts for all
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
