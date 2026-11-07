-- Hourly send counts for the dashboard's SES stats chart (Newsletter / Welcome
-- buttons). SES itself only knows the overall total, so the split comes from
-- our own records: newsletter = email_outbox rows sent, welcome = subscribers
-- whose welcome went out. Buckets are IST hours (xx:00 IST = xx:30 UTC),
-- returned as the UTC instant each IST hour starts.
create or replace function public.send_counts_hourly(p_from timestamptz, p_to timestamptz)
returns table (hour timestamptz, newsletter bigint, welcome bigint)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with n as (
    select date_trunc('hour', sent_at + interval '30 minutes') - interval '30 minutes' h, count(*) c
    from public.email_outbox
    where status = 'sent' and sent_at >= p_from and sent_at < p_to
    group by 1
  ), w as (
    select date_trunc('hour', welcome_sent_at + interval '30 minutes') - interval '30 minutes' h, count(*) c
    from public.subscribers
    where welcome_sent_at >= p_from and welcome_sent_at < p_to
    group by 1
  )
  select coalesce(n.h, w.h), coalesce(n.c, 0), coalesce(w.c, 0)
  from n full join w on n.h = w.h
  order by 1;
$$;

revoke all on function public.send_counts_hourly(timestamptz, timestamptz) from public, anon, authenticated;
