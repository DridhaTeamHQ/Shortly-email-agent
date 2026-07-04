-- pg_cron schedule for the Shortly daily CONTENT pipeline.
-- Times are UTC. India Standard Time is UTC+05:30.
--
-- Run AFTER schema.sql and after creating the Vault secret:
--   select vault.create_secret('<SERVICE_ROLE_KEY>', 'shortly_service_role_key');
--
-- This file is the source of truth for the LIVE cron jobs (project
-- ygxdrphajvrbjcaxhvcn). It is idempotent: re-running it unschedules the
-- shortly-* jobs and recreates them, so `supabase db push` never duplicates.
--
-- SCOPE: this schedules only content GENERATION (scrape -> summarize ->
-- corporate-case + editorial topics). It deliberately does NOT auto-send the
-- newsletter. send-newsletter / send-daily-digest only ship status='approved'
-- content, which requires human QA, so sending stays a manual operator action
-- in the dashboard. An optional auto-send block is provided (commented out) at
-- the bottom for when a same-day or prior-day QA-approval workflow exists.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Helper to call an Edge Function by name. Reads the service-role bearer from
-- Vault and RAISES if the secret is missing (fail loud, not a silent 401).
-- pg_net defaults to a 2s timeout, far too short for summarize/agents, so
-- callers pass an explicit timeout_ms (default 300s).
create or replace function public.invoke_edge(
  fn text,
  payload jsonb default '{}'::jsonb,
  timeout_ms integer default 300000
)
returns bigint
language plpgsql
security definer
as $fn$
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
    url := format('https://ygxdrphajvrbjcaxhvcn.supabase.co/functions/v1/%s', fn),
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
$fn$;

-- Idempotent: drop any prior shortly-* jobs (incl. legacy names from earlier
-- iterations of this file) before (re)scheduling.
do $do$
declare j text;
begin
  foreach j in array array[
    'shortly-scrape-news',
    'shortly-summarize-articles',
    'shortly-corporate-case-agent',
    'shortly-editorial-real-estate',
    'shortly-editorial-policy-partner',
    'shortly-editorial-money-matters',
    'shortly-editorial-wellness-daily',
    'shortly-send-newsletter',
    -- legacy names
    'shortly-scrape','shortly-summarize','shortly-send',
    'shortly-scrape-8am-ist','shortly-summarize-815am-ist','shortly-send-digest-9am-ist',
    'shortly-corporate-case-weekdays','shortly-real-estate-mon-sat','shortly-policy-partner-mon-sat',
    'shortly-money-matters-mon-sat','shortly-wellness-daily-mon-sat'
  ]
  loop
    if exists (select 1 from cron.job where jobname = j) then
      perform cron.unschedule(j);
    end if;
  end loop;
end
$do$;

-- 1) scrape-news      01:30 UTC = 07:00 IST, daily, no GPT (~5s)
select cron.schedule('shortly-scrape-news', '30 1 * * *',
  $job$ select public.invoke_edge('scrape-news', '{}'::jsonb, 60000); $job$);

-- 2) summarize        01:45 UTC = 07:15 IST, daily, gpt-4o-mini (~32s). 15-min gap after scrape.
select cron.schedule('shortly-summarize-articles', '45 1 * * *',
  $job$ select public.invoke_edge('summarize-articles', '{}'::jsonb, 120000); $job$);

-- 3) corporate-case   02:00 UTC = 07:30 IST, daily, gpt-4o (first serialized heavy run)
select cron.schedule('shortly-corporate-case-agent', '0 2 * * *',
  $job$ select public.invoke_edge('corporate-case-agent', '{}'::jsonb, 300000); $job$);

-- gpt-4o agents are serialized 8 min apart to stay under the ~30k TPM limit.
-- Editorial topics are restricted to Mon-Sat (1-6) per their topic configs.

-- 4) editorial real-estate    02:08 UTC = 07:38 IST, Mon-Sat, gpt-4o
select cron.schedule('shortly-editorial-real-estate', '8 2 * * 1-6',
  $job$ select public.invoke_edge('editorial-topic-agent', '{"topic":"real-estate"}'::jsonb, 300000); $job$);

-- 5) editorial policy-partner 02:16 UTC = 07:46 IST, Mon-Sat, gpt-4o
select cron.schedule('shortly-editorial-policy-partner', '16 2 * * 1-6',
  $job$ select public.invoke_edge('editorial-topic-agent', '{"topic":"policy-partner"}'::jsonb, 300000); $job$);

-- 6) editorial money-matters  02:24 UTC = 07:54 IST, Mon-Sat, gpt-4o
select cron.schedule('shortly-editorial-money-matters', '24 2 * * 1-6',
  $job$ select public.invoke_edge('editorial-topic-agent', '{"topic":"money-matters"}'::jsonb, 300000); $job$);

-- 7) editorial wellness-daily 02:32 UTC = 08:02 IST, Mon-Sat, gpt-4o (finishes ~08:07 IST)
select cron.schedule('shortly-editorial-wellness-daily', '32 2 * * 1-6',
  $job$ select public.invoke_edge('editorial-topic-agent', '{"topic":"wellness-daily"}'::jsonb, 300000); $job$);

-- ---------------------------------------------------------------------------
-- OPTIONAL: automated daily send at 09:00 IST (03:30 UTC).
-- DISABLED by default. send-newsletter only ships status='approved' content,
-- so before enabling this you need content to be APPROVED (human QA) ahead of
-- the send -- otherwise it ships the prior approved backlog or an empty issue.
-- Uncomment only once an approval workflow guarantees approved content by 03:30 UTC.
--
-- select cron.schedule('shortly-send-newsletter', '30 3 * * *',
--   $job$ select public.invoke_edge('send-newsletter', '{"scheduled":true}'::jsonb, 300000); $job$);

-- ---------------------------------------------------------------------------
-- VERIFY
--   select jobid, jobname, schedule, active from cron.job where jobname like 'shortly-%' order by schedule;
--   -- cron fired & enqueued (status='succeeded' just means the SQL ran):
--   select j.jobname, d.status, d.return_message, d.start_time
--     from cron.job_run_details d join cron.job j using (jobid)
--    where j.jobname like 'shortly-%' order by d.start_time desc limit 25;
--   -- actual HTTP result (net._http_response kept ~6h): 200 ok, 401 bad bearer, timed_out -> raise timeout
--   select id, status_code, timed_out, error_msg, left(content,300) content, created
--     from net._http_response order by created desc limit 25;
