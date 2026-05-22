-- pg_cron schedule for the Shortly daily pipeline.
-- Run AFTER schema.sql. Replace ygxdrphajvrbjcaxhvcn and <SERVICE_ROLE_KEY> below.
-- The service role key is read by pg_net via a vault secret.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Store the service role key once in Vault (preferred over inline).
-- select vault.create_secret('<SERVICE_ROLE_KEY>', 'shortly_service_role_key');

-- Helper to call an edge function by name.
create or replace function public.invoke_edge(fn text)
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

  select net.http_post(
    url := format('https://ygxdrphajvrbjcaxhvcn.functions.supabase.co/%s', fn),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', format('Bearer %s', key)
    ),
    body := '{}'::jsonb
  ) into request_id;

  return request_id;
end;
$$;

-- 07:00 UTC: scrape sources
select cron.schedule('shortly-scrape', '0 7 * * *', $$select public.invoke_edge('scrape-news');$$);

-- 07:30 UTC: summarize pending articles with GPT-4o
select cron.schedule('shortly-summarize', '30 7 * * *', $$select public.invoke_edge('summarize-articles');$$);

-- 15:00 UTC: send the day's approved digest (10 articles).
-- The QA team has 07:30 -> 15:00 UTC to review.
select cron.schedule('shortly-send', '0 15 * * *', $$select public.invoke_edge('send-daily-digest');$$);
