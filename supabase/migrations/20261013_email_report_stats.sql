-- Numbers for the team's report emails (stats-report function).
--
-- email_report_stats(day, batch) returns everything in one call:
--   newsletter  the day's 9 AM send: sent / delivered / blocked by SES /
--               hard + soft bounces / complaints / no report yet
--   welcome     one daily batch (or every batch received that day)
--   health      7-day hard-bounce + complaint rates (SES-blocked sends excluded)
--   list        subscribers, non-gmail left, eligible for the next newsletter
--   never_send  added that day and all-time, per reason
-- Read-only. Dates are IST calendar days.

alter table public.subscriber_groups
  add column if not exists welcome_report_sent_at timestamptz;

create or replace function public.email_report_stats(p_day date, p_batch_id uuid default null)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $$
with
win as (
  select (p_day::timestamp at time zone 'Asia/Kolkata') as t0,
         ((p_day + 1)::timestamp at time zone 'Asia/Kolkata') as t1
),
prevented as (select unnest(array['EmailValidationSuppressed', 'OnAccountSuppressionList', 'Suppressed']) as sub),
-- newsletter: the day's outbox, joined to SES results by message id
nl as (
  select o.status, o.provider_message_id
  from public.email_outbox o
  join public.digests d on d.id = o.digest_id and d.scheduled_key = 'outbox:' || p_day::text
),
nl_ev as (
  select distinct on (e.message_id) e.message_id, e.event_type, e.bounce_type, e.bounce_sub
  from public.email_events e
  where e.message_id in (select provider_message_id from nl where provider_message_id is not null)
  order by e.message_id, (e.event_type = 'bounce') desc, e.received_at
),
nl_complaints as (
  select count(distinct e.message_id) n from public.email_events e
  where e.event_type = 'complaint' and e.message_id in (select provider_message_id from nl)
),
-- welcome: members of the chosen batch, or of every batch received that day
wb as (
  select s.id, lower(s.email) email, s.welcome_sent_at, s.status
  from public.subscribers s
  join public.subscriber_group_members m on m.subscriber_id = s.id
  join public.subscriber_groups g on g.id = m.group_id and g.is_daily_batch
  where (p_batch_id is not null and g.id = p_batch_id)
     or (p_batch_id is null and g.received_on = p_day)
),
w_ev as (
  select lower(e.email) email,
         bool_or(e.event_type = 'delivery') delivered,
         bool_or(e.event_type = 'bounce' and e.bounce_sub = 'EmailValidationSuppressed') blocked,
         bool_or(e.event_type = 'bounce' and e.bounce_type = 'Permanent' and coalesce(e.bounce_sub, '') not in (select sub from prevented)) hard,
         bool_or(e.event_type = 'bounce' and coalesce(e.bounce_type, '') <> 'Permanent') soft,
         bool_or(e.event_type = 'complaint') complained
  from public.email_events e
  where lower(e.email) in (select email from wb)
    and e.raw->'mail'->'commonHeaders'->>'subject' ilike '%part of the club%'
  group by 1
),
batch_info as (
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', g.name, 'received_on', g.received_on, 'rows_in_file', g.rows_in_file,
           'added', g.added_count, 'duplicates', g.duplicate_count, 'rejected', g.invalid_count,
           'already_known', g.already_known_count, 'suppressed', g.suppressed_count) order by g.received_on), '[]'::jsonb) j
  from public.subscriber_groups g
  where g.is_daily_batch and ((p_batch_id is not null and g.id = p_batch_id) or (p_batch_id is null and g.received_on = p_day))
),
h as (
  select
    count(*) filter (where event_type = 'delivery') delivered,
    count(*) filter (where event_type = 'bounce' and bounce_type = 'Permanent' and coalesce(bounce_sub, '') not in (select sub from prevented)) hard,
    count(*) filter (where event_type = 'bounce' and bounce_sub = 'EmailValidationSuppressed') blocked,
    count(*) filter (where event_type = 'complaint') complaints
  from public.email_events where received_at > now() - interval '7 days'
),
ns_day as (select reason, count(*) n from public.email_suppressions, win where created_at >= win.t0 and created_at < win.t1 group by 1),
ns_all as (select reason, count(*) n from public.email_suppressions group by 1)
select jsonb_build_object(
  'day', p_day,
  'generated_at', now(),
  'newsletter', jsonb_build_object(
    'queued_total', (select count(*) from nl),
    'sent', (select count(*) from nl where status = 'sent'),
    'not_sent', (select count(*) from nl where status <> 'sent'),
    'delivered', (select count(*) from nl_ev where event_type = 'delivery'),
    'blocked_by_ses', (select count(*) from nl_ev where bounce_sub = 'EmailValidationSuppressed'),
    'hard_bounces', (select count(*) from nl_ev where event_type = 'bounce' and bounce_type = 'Permanent' and coalesce(bounce_sub, '') not in (select sub from prevented)),
    'soft_bounces', (select count(*) from nl_ev where event_type = 'bounce' and coalesce(bounce_type, '') <> 'Permanent'),
    'complaints', (select n from nl_complaints),
    'no_report_yet', (select count(*) from nl where status = 'sent') - (select count(*) from nl_ev),
    'website_accounts_sent', (select coalesce(sum(sent), 0) from public.digests, win where scheduled_key is null and sent_at >= win.t0 and sent_at < win.t1)
  ),
  'welcome', jsonb_build_object(
    'batches', (select j from batch_info),
    'members', (select count(*) from wb),
    'welcome_sent', (select count(*) from wb where welcome_sent_at is not null),
    'welcome_pending', (select count(*) from wb where welcome_sent_at is null and status = 'subscribed'),
    'delivered', (select count(*) from w_ev where delivered),
    'blocked_by_ses', (select count(*) from w_ev where blocked),
    'hard_bounces', (select count(*) from w_ev where hard),
    'soft_bounces', (select count(*) from w_ev where soft and not delivered),
    'complaints', (select count(*) from w_ev where complained),
    'no_report_yet', (select count(*) from wb where welcome_sent_at is not null and email not in (select email from w_ev)),
    'active_now', (select count(*) from wb where status = 'subscribed')
  ),
  'health', jsonb_build_object(
    'delivered_7d', (select delivered from h),
    'hard_bounces_7d', (select hard from h),
    'hard_bounce_rate_pct', (select round(100.0 * hard / nullif(delivered + hard, 0), 2) from h),
    'blocked_by_ses_7d', (select blocked from h),
    'complaints_7d', (select complaints from h),
    'complaint_rate_pct', (select round(100.0 * complaints / nullif(delivered, 0), 3) from h),
    'unsubscribed_today', (select count(*) from public.subscribers, win where unsubscribed_at >= win.t0 and unsubscribed_at < win.t1)
  ),
  'list', jsonb_build_object(
    'subscribed', (select count(*) from public.subscribers where status = 'subscribed'),
    'non_gmail_subscribed', (select count(*) from public.subscribers where status = 'subscribed' and split_part(lower(email), '@', 2) <> 'gmail.com'),
    'eligible_next_newsletter', (select count(*) from public.subscribers
      where status = 'subscribed' and verification_status = 'valid'
        and (welcome_requested_at is null or newsletter_from <= p_day + 1)
        and not exists (select 1 from public.email_suppressions x where x.email = lower(subscribers.email)))
  ),
  'never_send', jsonb_build_object(
    'added_today', (select coalesce(sum(n), 0) from ns_day),
    'added_today_by_reason', (select coalesce(jsonb_object_agg(reason, n), '{}'::jsonb) from ns_day),
    'total', (select coalesce(sum(n), 0) from ns_all),
    'total_by_reason', (select coalesce(jsonb_object_agg(reason, n), '{}'::jsonb) from ns_all)
  )
);
$$;

revoke all on function public.email_report_stats(date, uuid) from public, anon, authenticated;
grant execute on function public.email_report_stats(date, uuid) to service_role;
