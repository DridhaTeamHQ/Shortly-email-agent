-- Subscriber privacy controls and bounded operational retention.

alter table public.subscribers
  add column if not exists unsubscribed_at timestamptz;

create index if not exists subscribers_unsubscribed_at_idx
  on public.subscribers (unsubscribed_at)
  where status in ('unsubscribed', 'bounced');

create or replace function public.shortly_cleanup_privacy_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Delivery logs contain recipient email addresses. Keep enough history for
  -- operational debugging, then remove the personal data automatically.
  delete from public.article_deliveries
  where created_at < now() - interval '180 days';

  -- Digest rows are aggregate send history and can be retained longer.
  delete from public.digests
  where sent_at < now() - interval '365 days';

  -- A user who unsubscribed or hard-bounced is removed after the retention
  -- window. Active subscribers are never touched.
  delete from public.subscribers
  where status in ('unsubscribed', 'bounced')
    and coalesce(unsubscribed_at, updated_at) < now() - interval '730 days';
end;
$$;

revoke all on function public.shortly_cleanup_privacy_data() from public, anon, authenticated;
grant execute on function public.shortly_cleanup_privacy_data() to service_role;

create extension if not exists pg_cron;
do $schedule$
begin
  if exists (select 1 from cron.job where jobname = 'shortly-cleanup-privacy-data') then
    perform cron.unschedule('shortly-cleanup-privacy-data');
  end if;
  perform cron.schedule(
    'shortly-cleanup-privacy-data',
    '15 19 * * *',
    $job$ select public.shortly_cleanup_privacy_data(); $job$
  );
end
$schedule$;
