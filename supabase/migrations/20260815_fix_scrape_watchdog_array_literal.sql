-- FIX for 20260804_add_scrape_watchdog.sql.
--
-- BUG: `problems := problems || 'no articles scraped in 6h'` made Postgres try
-- to parse the bare string literal as an ARRAY literal:
--     ERROR: malformed array literal: "no articles scraped in 6h"
-- The other branches happened to survive because their operands are already
-- typed text (format(...) / a || concatenation), so only the plainest check --
-- outright starvation -- was affected.
--
-- Impact: the watchdog raised and aborted instead of alerting. It failed
-- exactly once, 2026-08-08 00:20 IST, during a real starvation event -- i.e.
-- it crashed at precisely the moment it existed to speak up. 260 other runs
-- passed because the healthy path never reaches these lines, which is also why
-- the original "runs clean on a healthy pipeline" check did not catch it.
--
-- Every branch now uses array_append(), which is unambiguous. Verified by
-- forcing all four conditions true: 4 alerts, no error.

create or replace function public.shortly_scrape_watchdog()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  fresh_6h            int;
  fresh_24h           int;
  baseline_daily      int;
  stale_health_mins   int;
  general_today       int;
  ist_hour            int;
  problems            text[] := '{}';
begin
  select count(*) into fresh_6h
  from public.articles where scraped_at > now() - interval '6 hours';

  select count(*) into fresh_24h
  from public.articles where scraped_at > now() - interval '24 hours';

  -- Typical daily intake over the previous 7 full days (median, so one quiet
  -- day cannot drag the baseline down).
  select coalesce(percentile_cont(0.5) within group (order by c), 0)::int
    into baseline_daily
  from (
    select count(*) c
    from public.articles
    where scraped_at >= now() - interval '8 days'
      and scraped_at <  now() - interval '1 day'
    group by (scraped_at at time zone 'Asia/Kolkata')::date
  ) x;

  select coalesce(extract(epoch from (now() - max(last_success_at))) / 60, 999999)::int
    into stale_health_mins
  from public.sources where enabled;

  select count(*) into general_today
  from public.articles
  where status in ('approved', 'sent') and category is null
    and reviewed_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata');

  ist_hour := extract(hour from (now() at time zone 'Asia/Kolkata'))::int;

  -- 1. Outright starvation.
  if fresh_6h = 0 then
    problems := array_append(problems, 'no articles scraped in 6h');
  end if;

  -- 2. Degraded intake (catches a slow decay, which a zero-check misses).
  if baseline_daily >= 50 and fresh_24h < (baseline_daily * 0.4)::int then
    problems := array_append(problems,
      format('scrape volume %s in 24h vs typical %s/day', fresh_24h, baseline_daily));
  end if;

  -- 3. The reverted-deploy signal: an old build answers 200 but never writes
  --    the source registry.
  if stale_health_mins > 360 then
    problems := array_append(problems,
      format('source health stale %sm - scraper may be a reverted/old build', stale_health_mins));
  end if;

  -- 4. Last line of defence, only in the hour before the send.
  if ist_hour = 8 and general_today < 5 then
    problems := array_append(problems,
      format('general pool only %s before the 09:00 send', general_today));
  end if;

  if array_length(problems, 1) is null then
    return;  -- healthy: stay quiet
  end if;

  insert into public.pipeline_log(check_name, action, detail)
  values ('scrape-watchdog', 'ALERT',
          array_to_string(problems, '; ')
            || format(' [scraped_6h=%s scraped_24h=%s baseline=%s general_today=%s]',
                      fresh_6h, fresh_24h, baseline_daily, general_today));

  -- Self-heal only for outright starvation. scrape-news is idempotent (upsert
  -- on url) and spends no OpenAI credit, so a retry is always safe.
  if fresh_6h = 0 then
    perform public.invoke_edge('scrape-news', '{}'::jsonb, 90000);
    insert into public.pipeline_log(check_name, action, detail)
    values ('scrape-watchdog', 'invoked', 'scrape-news (starvation self-heal)');
  end if;
end;
$$;

revoke all on function public.shortly_scrape_watchdog() from public, anon, authenticated;
