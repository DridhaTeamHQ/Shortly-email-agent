-- Welcome ramp by real usage (owner, 2026-11-12): the next step comes only
-- after the CURRENT step was actually sent on 3 days. Calendar dates no longer
-- matter: if the pool is empty for a week, the limit waits where it is, so a
-- list given after a gap never jumps straight to a big number.
--
--   full day   = that IST day's daily batch added_count >= 90% of the limit
--                (a few addresses SES rejects do not spoil the day)
--   counted    = full days since the limit last changed, before today
--   3 full days + last 3 days clean  -> next higher step in welcome_ramp_plan
--   not clean (hard bounces >= 0.5% or complaints >= 0.1%, 500+ deliveries)
--                                    -> one step down; the 3 days start again
--   ramp_ceiling (default 400 = DAILY_BATCH_MAX): never raised above it. When
--   the owner checks Postmaster and raises DAILY_BATCH_MAX, ramp_ceiling is
--   raised with it.
--
-- welcome_ramp_plan.start_on is kept only as the order of the steps.

alter table public.welcome_pool_settings
  add column if not exists ramp_ceiling integer not null default 400 check (ramp_ceiling between 1 and 2500),
  add column if not exists ramp_changed_on date;

update public.welcome_pool_settings
   set ramp_changed_on = (updated_at at time zone 'Asia/Kolkata')::date
 where id and ramp_changed_on is null;

-- Any change of the limit (dashboard, chat, or the ramp) restarts the 3 days.
create or replace function public.welcome_limit_changed()
returns trigger
language plpgsql
as $$
begin
  if new.daily_limit is distinct from old.daily_limit then
    new.ramp_changed_on := (now() at time zone 'Asia/Kolkata')::date;
  end if;
  return new;
end;
$$;
drop trigger if exists welcome_limit_changed on public.welcome_pool_settings;
create trigger welcome_limit_changed before update on public.welcome_pool_settings
  for each row execute function public.welcome_limit_changed();

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
    select max(daily_limit) into lower_step from welcome_ramp_plan where daily_limit < cur;
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

  select min(daily_limit) into next_step from welcome_ramp_plan where daily_limit > cur;

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
