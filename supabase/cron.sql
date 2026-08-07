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
-- SCOPE: this schedules the full production pipeline:
--   midnight cleanup -> General scrape/summarize -> category short articles +
--   case-study drafts -> one coordinated 09:00 IST send-newsletter run.
-- send-newsletter only ships same-day status='approved' content, so QA still
-- controls what goes out; old approved/review rows are cleared after midnight.

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

-- Clear yesterday's unreviewed QA pools just after IST midnight so Review never
-- mixes old rows with today's scrape. Approved rows are preserved as database
-- history, but list/send functions only show/use same-day approved content.
create or replace function public.shortly_cleanup_daily_review_pools()
returns void
language plpgsql
security definer
as $cleanup$
declare
  ist_start timestamptz;
begin
  ist_start := ((now() at time zone 'Asia/Kolkata')::date at time zone 'Asia/Kolkata');

  delete from public.articles
  where status in ('pending', 'summarized', 'rejected')
    and coalesce(reviewed_at, summarized_at, scraped_at, created_at) < ist_start;

  delete from public.editorial_drafts
  where status in ('draft', 'rejected')
    and coalesce(updated_at, generated_at, created_at) < ist_start;
end;
$cleanup$;

-- SECURITY: both helpers above are SECURITY DEFINER and invoke_edge injects the
-- service-role bearer for ANY edge function name it is handed. PostgREST exposes
-- public-schema functions as RPC, and Postgres grants EXECUTE to PUBLIC by
-- default — so without this revoke, anyone holding the public anon key could
-- POST /rest/v1/rpc/invoke_edge to run any function (or the cleanup delete) with
-- full service-role privileges. Lock both to the owner (postgres) that pg_cron
-- runs as. SECURITY DEFINER means the revoke does not stop pg_cron from calling
-- them.
revoke all on function public.invoke_edge(text, jsonb, integer) from public, anon, authenticated;
-- Legacy single-arg overload from an earlier iteration may still exist; lock it
-- too. Wrapped so this file stays runnable on projects that never had it.
do $revoke$ begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.oid = 'public.invoke_edge(text)'::regprocedure
  ) then
    revoke all on function public.invoke_edge(text) from public, anon, authenticated;
  end if;
exception when undefined_function then null;
end $revoke$;
revoke all on function public.shortly_cleanup_daily_review_pools() from public, anon, authenticated;

-- Idempotent: drop any prior shortly-* jobs (incl. legacy names from earlier
-- iterations of this file) before (re)scheduling.
do $do$
declare j text;
begin
  foreach j in array array[
    'shortly-scrape-news',
    'shortly-summarize-articles',
    'shortly-summarize-articles-2',
    'shortly-auto-approve-morning-general',
    'shortly-corporate-case-agent',
    'shortly-editorial-real-estate',
    'shortly-editorial-automobile',
    'shortly-editorial-health-wellness',
    'shortly-editorial-tech-ai',
    'shortly-editorial-markets-startups',
    'shortly-send-newsletter',
    'shortly-backfill-fact-scores',
    'shortly-cleanup-midnight-ist',
    'shortly-cleanup-privacy-data',
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

-- 0) cleanup old Review/Approved pools 18:35 UTC = 00:05 IST, daily.
select cron.schedule('shortly-cleanup-midnight-ist', '35 18 * * *',
  $job$ select public.shortly_cleanup_daily_review_pools(); $job$);

-- Privacy retention: remove old delivery PII, old aggregate digest logs, and
-- long-inactive unsubscribed/bounced subscriber records. Approved editorial
-- content is not affected by this job.
select cron.schedule('shortly-cleanup-privacy-data', '15 19 * * *',
  $job$ select public.shortly_cleanup_privacy_data(); $job$);

-- 1) General scrape-news 00:30 UTC = 06:00 IST, daily, no GPT.
select cron.schedule('shortly-scrape-news', '30 0 * * *',
  $job$ select public.invoke_edge('scrape-news', '{}'::jsonb, 60000); $job$);

-- 2) Summarize General in two capped passes to keep a 20-50 article pool.
-- 300s timeout (was 120s): each article now makes a summary AND a fact-check
-- call, so a full 40-article pass with 429 backoff can exceed 120s and log a
-- spurious pg_net timed_out even though the isolate finishes and writes rows.
select cron.schedule('shortly-summarize-articles', '45 0 * * *',
  $job$ select public.invoke_edge('summarize-articles', '{}'::jsonb, 300000); $job$);

select cron.schedule('shortly-summarize-articles-2', '5 1 * * *',
  $job$ select public.invoke_edge('summarize-articles', '{}'::jsonb, 300000); $job$);

-- 2b) Approve the five strongest completed General stories at 07:10 IST,
-- leaving enough time for both summary passes before the 09:00 IST send.
select cron.schedule('shortly-auto-approve-morning-general', '40 1 * * *',
  $job$ select public.invoke_edge('auto-approve-general', '{"scheduled":true}'::jsonb, 300000); $job$);

-- 3) Category agents. Each run creates:
--    - up to 25 short articles for that category review pool
--    - up to 5 case-study drafts for that category case-study pool
-- Serialized to avoid OpenAI TPM/runtime spikes.

select cron.schedule('shortly-editorial-real-estate', '20 1 * * *',
  $job$ select public.invoke_edge('editorial-topic-agent', '{"topic":"real-estate"}'::jsonb, 300000); $job$);

select cron.schedule('shortly-editorial-automobile', '32 1 * * *',
  $job$ select public.invoke_edge('editorial-topic-agent', '{"topic":"automobile"}'::jsonb, 300000); $job$);

select cron.schedule('shortly-editorial-health-wellness', '44 1 * * *',
  $job$ select public.invoke_edge('editorial-topic-agent', '{"topic":"health-wellness"}'::jsonb, 300000); $job$);

select cron.schedule('shortly-editorial-tech-ai', '56 1 * * *',
  $job$ select public.invoke_edge('editorial-topic-agent', '{"topic":"tech-ai"}'::jsonb, 300000); $job$);

select cron.schedule('shortly-editorial-markets-startups', '8 2 * * *',
  $job$ select public.invoke_edge('editorial-topic-agent', '{"topic":"markets-startups"}'::jsonb, 300000); $job$);

-- Fact-score backfill intentionally disabled. New articles are fact-checked
-- inline by the scrape/summarize pipelines; the old daily sweep consumed
-- unnecessary OpenAI credits.

-- 4) Send every subscribed product at 09:00 IST (03:30 UTC). General and
-- case-study products are daily; category short-article products are sent on
-- their chosen weekday/rhythm inside send-newsletter.
select cron.schedule('shortly-send-newsletter', '30 3 * * *',
  $job$ select public.invoke_edge('send-newsletter', '{"scheduled":true}'::jsonb, 300000); $job$);

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
