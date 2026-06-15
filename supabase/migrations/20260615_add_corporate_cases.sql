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

create index if not exists corporate_cases_status_idx
  on public.corporate_cases (status, generated_at desc);

alter table public.corporate_cases enable row level security;

drop policy if exists "Service role can manage corporate cases" on public.corporate_cases;
create policy "Service role can manage corporate cases"
  on public.corporate_cases for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
