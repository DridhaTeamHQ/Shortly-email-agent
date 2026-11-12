-- Welcome pool release in small chunks (2026-11-12).
-- On 12 Nov the 250-address upload needed ~3 min for the SES checks; the
-- gateway gives up after 150 s (504) while the upload still finished, and the
-- release put the rows back in the pool. Now:
--   * release-welcome-pool takes at most 120 per call (fits well inside 150 s)
--   * cron calls it every 10 minutes from 12:00 to 14:50 IST until today's
--     limit is filled (18 calls x 120 = 2,160 max; extend when the limit nears it)
--   * welcome_pool_reconcile() runs first in every call and fixes the pool
--     from the real state, so a 504 or crash can never lose or double rows.

create or replace function public.welcome_pool_reconcile(p_today date)
returns void
language sql
security definer
set search_path = public
as $$
  -- already on the subscriber list or never-send list -> counts as released
  update welcome_pool p set released_on = p_today
   where released_on is null
     and (exists (select 1 from subscribers s where lower(s.email) = p.email)
          or exists (select 1 from email_suppressions x where lower(x.email) = p.email));
  -- released on an earlier day but never added or blocked -> back in the pool
  update welcome_pool p set released_on = null
   where released_on < p_today
     and not exists (select 1 from subscribers s where lower(s.email) = p.email)
     and not exists (select 1 from email_suppressions x where lower(x.email) = p.email);
$$;
revoke all on function public.welcome_pool_reconcile(date) from public, anon, authenticated;
grant execute on function public.welcome_pool_reconcile(date) to service_role;

select cron.unschedule('shortly-release-welcome-pool');
select cron.schedule(
  'shortly-release-welcome-pool',
  '*/10 6-9 * * *',
  $$ select public.invoke_edge('release-welcome-pool', '{}'::jsonb, 150000)
      where (now() at time zone 'Asia/Kolkata')::time >= '12:00'
        and (now() at time zone 'Asia/Kolkata')::time <  '15:00'; $$
);
