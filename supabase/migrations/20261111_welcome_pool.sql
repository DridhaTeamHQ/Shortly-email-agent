-- Welcome pool: a bulk list the owner hands over once, released a bit each day
-- on the server (owner, 2026-11-11), so it runs with nobody's computer on.
--
--   welcome_pool             addresses waiting; released_on is set when a day's
--                            release takes them
--   welcome_pool_settings    one row: daily_limit (welcome mails per IST day,
--                            counting any batch uploaded by hand that day too)
--   cron 06:30 UTC (12:00 IST) -> release-welcome-pool, which runs the normal
--   import-batch on the next addresses (all pre-checks + SES validation), so
--   send-welcomes mails them and the welcome report follows as usual.
create table if not exists public.welcome_pool (
  email text primary key check (email = lower(email)),
  full_name text,
  source text,
  added_at timestamptz not null default now(),
  released_on date
);
create index if not exists welcome_pool_waiting on public.welcome_pool (added_at, email) where released_on is null;

create table if not exists public.welcome_pool_settings (
  id boolean primary key default true check (id),
  daily_limit integer not null default 250 check (daily_limit between 0 and 2500),
  updated_at timestamptz not null default now()
);
insert into public.welcome_pool_settings (id, daily_limit) values (true, 250) on conflict (id) do nothing;

alter table public.welcome_pool enable row level security;
alter table public.welcome_pool_settings enable row level security;
revoke all on public.welcome_pool, public.welcome_pool_settings from anon, authenticated;

select cron.schedule(
  'shortly-release-welcome-pool',
  '30 6 * * *',
  $$ select public.invoke_edge('release-welcome-pool', '{}'::jsonb, 150000); $$
);
