-- Welcome ramp (owner, 2026-11-12): raise the welcome pool's daily_limit step
-- by step on a schedule, but only while the last 3 days are clean.
--
--   welcome_ramp_plan   start_on (IST date) -> daily_limit; the dates are the
--                       EARLIEST day a step may start
--   welcome_ramp_tick() daily 06:20 UTC (11:50 IST, 10 min before the 12:00
--                       release):
--     * last 3 days hard bounces >= 0.5% or complaints >= 0.1% (once there are
--       500+ deliveries)  -> go back one step and push every later step back
--                            7 days
--     * clean and today's planned step is higher -> raise to it
--     * otherwise leave the limit alone (a limit the owner set by hand that is
--       higher than the plan is never lowered on a clean day)
--
-- Gmail does not send spam complaints to SES, so this cannot see the Postmaster
-- spam rate; it only sees bounces and the few non-Gmail complaints. Steps above
-- 400 also need the owner to raise the DAILY_BATCH_MAX secret
-- (release-welcome-pool clamps to it), which is the moment to check Postmaster.

create table if not exists public.welcome_ramp_plan (
  start_on date primary key,
  daily_limit integer not null check (daily_limit between 1 and 2500)
);
alter table public.welcome_ramp_plan enable row level security;
revoke all on public.welcome_ramp_plan from anon, authenticated;

insert into public.welcome_ramp_plan (start_on, daily_limit) values
  ('2026-11-12', 250),
  ('2026-11-16', 350),
  ('2026-11-19', 400),
  ('2026-11-23', 600),
  ('2026-11-27', 900),
  ('2026-12-01', 1300),
  ('2026-12-05', 1800),
  ('2026-12-09', 2500)
on conflict (start_on) do nothing;

alter table public.welcome_pool_settings
  add column if not exists ramp_enabled boolean not null default true,
  add column if not exists ramp_note text;

create or replace function public.welcome_ramp_tick()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Asia/Kolkata')::date;
  cur int;
  enabled boolean;
  planned int;
  lower_step int;
  delivered int;
  hard int;
  complaints int;
  note text;
begin
  select daily_limit, ramp_enabled into cur, enabled from welcome_pool_settings where id;
  if not coalesce(enabled, false) then return 'ramp off'; end if;

  select count(*) filter (where event_type = 'delivery'),
         count(*) filter (where event_type = 'bounce' and bounce_type = 'Permanent'
                          and coalesce(bounce_sub, '') not in ('EmailValidationSuppressed', 'OnAccountSuppressionList', 'Suppressed')),
         count(*) filter (where event_type = 'complaint')
    into delivered, hard, complaints
    from email_events
   where received_at > now() - interval '3 days';

  if delivered >= 500 and (hard::numeric / delivered >= 0.005 or complaints::numeric / delivered >= 0.001) then
    select max(daily_limit) into lower_step from welcome_ramp_plan where daily_limit < cur;
    update welcome_ramp_plan set start_on = start_on + 7 where start_on > today;
    note := format('%s: NOT clean (3 days: %s delivered, %s hard bounces, %s complaints) - %s -> %s, later steps moved 7 days',
                   today, delivered, hard, complaints, cur, coalesce(lower_step, cur));
    update welcome_pool_settings set daily_limit = coalesce(lower_step, cur), ramp_note = note, updated_at = now() where id;
    return note;
  end if;

  select daily_limit into planned from welcome_ramp_plan where start_on <= today order by start_on desc limit 1;
  if planned is not null and planned > cur then
    note := format('%s: clean (3 days: %s delivered, %s hard bounces, %s complaints) - raised %s -> %s',
                   today, delivered, hard, complaints, cur, planned);
    update welcome_pool_settings set daily_limit = planned, ramp_note = note, updated_at = now() where id;
  else
    note := format('%s: clean (3 days: %s delivered, %s hard bounces, %s complaints) - stays %s',
                   today, delivered, hard, complaints, cur);
    update welcome_pool_settings set ramp_note = note where id;
  end if;
  return note;
end;
$$;
revoke all on function public.welcome_ramp_tick() from public, anon, authenticated;

select cron.schedule(
  'shortly-welcome-ramp',
  '20 6 * * *',
  $$ select public.welcome_ramp_tick(); $$
);
