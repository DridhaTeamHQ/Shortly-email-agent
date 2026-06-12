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
  'shortly-send-digest-9am-ist'
);

-- 02:30 UTC (08:00 IST): scrape sources.
select cron.schedule(
  'shortly-scrape-8am-ist',
  '30 2 * * *',
  $$select public.invoke_edge('scrape-news', '{}'::jsonb, 60000);$$
);

-- 02:45 UTC (08:15 IST): summarize pending articles with GPT-4o.
select cron.schedule(
  'shortly-summarize-815am-ist',
  '45 2 * * *',
  $$select public.invoke_edge('summarize-articles', '{}'::jsonb, 300000);$$
);

-- 03:30 UTC (09:00 IST): send the day's digest.
-- The body keeps this compatible with the current manual-send guard.
select cron.schedule(
  'shortly-send-digest-9am-ist',
  '30 3 * * *',
  $$select public.invoke_edge('send-daily-digest', '{"manual": true}'::jsonb, 300000);$$
);
