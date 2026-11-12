-- Welcome ramp: steps instead of dates (owner, 2026-11-12).
-- Since 20261112_welcome_ramp_usage the ramp moves by REAL usage (3 full,
-- clean days), not by dates, but welcome_ramp_plan still showed the old
-- start_on dates, which looked like a date plan. Replace it with
-- welcome_ramp_steps (step number + limit). welcome_ramp_tick() only ever
-- used the order of daily_limit, so its behaviour does not change.
create table if not exists public.welcome_ramp_steps (
  step integer primary key,
  daily_limit integer not null unique check (daily_limit between 1 and 2500),
  note text
);
alter table public.welcome_ramp_steps enable row level security;
revoke all on public.welcome_ramp_steps from anon, authenticated;

insert into public.welcome_ramp_steps (step, daily_limit, note) values
  (1, 250,  'start'),
  (2, 350,  'after 3 full clean days at 250'),
  (3, 400,  'after 3 full clean days at 350; current safety cap'),
  (4, 600,  'needs owner: check Postmaster, raise DAILY_BATCH_MAX + ramp_ceiling'),
  (5, 900,  'after 3 full clean days at 600'),
  (6, 1300, 'after 3 full clean days at 900'),
  (7, 1800, 'after 3 full clean days at 1300'),
  (8, 2500, 'after 3 full clean days at 1800; system maximum')
on conflict (step) do nothing;

create or replace function public.welcome_ramp_tick()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Asia/Kolkata')::date;
  s record;
  cur int;
  since date;
  full_days int;
  next_step int;
  lower_step int;
  delivered int;
  hard int;
  complaints int;
  health text;
  note text;
begin
  select * into s from welcome_pool_settings where id;
  if not coalesce(s.ramp_enabled, false) then return 'ramp off'; end if;
  cur := s.daily_limit;
  since := coalesce(s.ramp_changed_on, today);

  select count(*) filter (where event_type = 'delivery'),
         count(*) filter (where event_type = 'bounce' and bounce_type = 'Permanent'
                          and coalesce(bounce_sub, '') not in ('EmailValidationSuppressed', 'OnAccountSuppressionList', 'Suppressed')),
         count(*) filter (where event_type = 'complaint')
    into delivered, hard, complaints
    from email_events
   where received_at > now() - interval '3 days';
  health := format('3 days: %s delivered, %s hard bounces, %s complaints', delivered, hard, complaints);

  if delivered >= 500 and (hard::numeric / delivered >= 0.005 or complaints::numeric / delivered >= 0.001) then
    select max(daily_limit) into lower_step from welcome_ramp_steps where daily_limit < cur;
    note := format('%s: NOT clean (%s) - %s -> %s, 3 full days needed again', today, health, cur, coalesce(lower_step, cur));
    update welcome_pool_settings
       set daily_limit = coalesce(lower_step, cur), ramp_changed_on = today, ramp_note = note, updated_at = now()
     where id;
    return note;
  end if;

  select count(*) into full_days
    from subscriber_groups
   where is_daily_batch and received_on >= since and received_on < today
     and added_count >= ceil(cur * 0.9);

  select min(daily_limit) into next_step from welcome_ramp_steps where daily_limit > cur;

  if full_days >= 3 and next_step is not null and next_step <= s.ramp_ceiling then
    note := format('%s: clean (%s), %s full days at %s - raised %s -> %s', today, health, full_days, cur, cur, next_step);
    update welcome_pool_settings
       set daily_limit = next_step, ramp_changed_on = today, ramp_note = note, updated_at = now()
     where id;
  elsif full_days >= 3 and next_step is not null then
    note := format('%s: clean (%s), %s full days at %s - next step %s waits: above the %s cap (check Postmaster, then raise DAILY_BATCH_MAX and ramp_ceiling)',
                   today, health, full_days, cur, next_step, s.ramp_ceiling);
    update welcome_pool_settings set ramp_note = note where id;
  else
    note := format('%s: clean (%s), %s of 3 full days at %s - stays %s', today, health, full_days, cur, cur);
    update welcome_pool_settings set ramp_note = note where id;
  end if;
  return note;
end;
$$;
revoke all on function public.welcome_ramp_tick() from public, anon, authenticated;

drop table if exists public.welcome_ramp_plan;
