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
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists editorial_drafts_topic_idx on public.editorial_drafts (topic_slug, generated_at desc);
alter table public.editorial_drafts enable row level security;

drop policy if exists "Service role can manage editorial drafts" on public.editorial_drafts;
create policy "Service role can manage editorial drafts"
  on public.editorial_drafts for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
