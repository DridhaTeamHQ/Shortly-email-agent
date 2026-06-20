-- pg_cron schedule for the Shortly daily pipeline.
-- Times are UTC. India Standard Time is UTC+05:30.
-- Run AFTER schema.sql and after creating the Vault secret:
-- select vault.create_secret('<SERVICE_ROLE_KEY>', 'shortly_service_role_key');

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Helper to call an Edge Function by name.
-- pg_net defaults to a 5s timeout, which is too short for summarize/send.
create or replace function public.invoke_edge(
  fn text,
  payload jsonb default '{}'::jsonb,
  timeout_ms integer default 300000
)
returns bigint
language plpgsql
security definer
as $$
declare
  request_id bigint;
  key text;
begin
  select decrypted_secret into key
  from vault.decrypted_secrets
  where name = 'shortly_service_role_key';

  if key is null then
    raise exception 'Missing Vault secret: shortly_service_role_key';
  end if;

  select net.http_post(
    url := format('https://ygxdrphajvrbjcaxhvcn.functions.supabase.co/%s', fn),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', format('Bearer %s', key),
      'apikey', key
    ),
    body := payload,
    timeout_milliseconds := timeout_ms
  ) into request_id;

  return request_id;
end;
$$;

-- Keep reruns idempotent.
select cron.unschedule(jobname)
from cron.job
where jobname in (
  'shortly-scrape',
  'shortly-summarize',
  'shortly-send',
  'shortly-scrape-8am-ist',
  'shortly-summarize-815am-ist',
  'shortly-send-digest-9am-ist',
  'shortly-corporate-case-weekdays',
  'shortly-real-estate-mon-sat',
  'shortly-policy-partner-mon-sat',
  'shortly-money-matters-mon-sat',
  'shortly-wellness-daily-mon-sat'
);

-- Every 3 hours (00:00, 03:00, ... UTC): scrape sources.
select cron.schedule(
  'shortly-scrape-8am-ist',
  '0 */3 * * *',
  $$select public.invoke_edge('scrape-news', '{}'::jsonb, 60000);$$
);

-- Every 3 hours, 15 min after the scrape: summarize pending articles with GPT-4o.
select cron.schedule(
  'shortly-summarize-815am-ist',
  '15 */3 * * *',
  $$select public.invoke_edge('summarize-articles', '{}'::jsonb, 300000);$$
);

-- 03:30 UTC (09:00 IST): send the day's digest.
-- The body keeps this compatible with the current manual-send guard.
select cron.schedule(
  'shortly-send-digest-9am-ist',
  '30 3 * * *',
  $$select public.invoke_edge('send-daily-digest', '{"manual": true}'::jsonb, 300000);$$
);

-- Category agents also run every 3 hours, staggered within each cycle to avoid
-- overlapping long OpenAI/source-fetch runs.
select cron.schedule(
  'shortly-corporate-case-weekdays',
  '30 */3 * * *',
  $$select public.invoke_edge('corporate-case-agent', '{}'::jsonb, 300000);$$
);

select cron.schedule(
  'shortly-real-estate-mon-sat',
  '35 */3 * * *',
  $$select public.invoke_edge('editorial-topic-agent', '{"topic":"real-estate"}'::jsonb, 300000);$$
);

select cron.schedule(
  'shortly-policy-partner-mon-sat',
  '40 */3 * * *',
  $$select public.invoke_edge('editorial-topic-agent', '{"topic":"policy-partner"}'::jsonb, 300000);$$
);

select cron.schedule(
  'shortly-money-matters-mon-sat',
  '45 */3 * * *',
  $$select public.invoke_edge('editorial-topic-agent', '{"topic":"money-matters"}'::jsonb, 300000);$$
);

select cron.schedule(
  'shortly-wellness-daily-mon-sat',
  '50 */3 * * *',
  $$select public.invoke_edge('editorial-topic-agent', '{"topic":"wellness-daily"}'::jsonb, 300000);$$
);
