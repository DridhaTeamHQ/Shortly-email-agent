create table if not exists public.subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  full_name text,
  status text not null default 'subscribed' check (status in ('subscribed', 'unsubscribed', 'bounced')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.articles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  url text not null,
  summary text not null,
  source text,
  topic text,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.article_deliveries (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  subscriber_id uuid references public.subscribers(id) on delete set null,
  email text not null,
  status text not null check (status in ('sent', 'failed')),
  provider_message_id text,
  error text,
  created_at timestamptz not null default now()
);

alter table public.subscribers enable row level security;
alter table public.articles enable row level security;
alter table public.article_deliveries enable row level security;

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
