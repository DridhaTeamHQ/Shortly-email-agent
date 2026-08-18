-- Reusable, agent-managed subscriber groups. These are separate from newsletter
-- topics so editorial delivery preferences remain unchanged.
create table if not exists public.subscriber_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);

create unique index if not exists subscriber_groups_name_key
  on public.subscriber_groups (lower(name));

create table if not exists public.subscriber_group_members (
  subscriber_id uuid not null references public.subscribers(id) on delete cascade,
  group_id uuid not null references public.subscriber_groups(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (subscriber_id, group_id)
);

create index if not exists subscriber_group_members_group_idx
  on public.subscriber_group_members (group_id, subscriber_id);

alter table public.subscriber_groups enable row level security;
alter table public.subscriber_group_members enable row level security;

create policy "Service role can manage subscriber groups"
  on public.subscriber_groups for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Service role can manage subscriber group members"
  on public.subscriber_group_members for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

