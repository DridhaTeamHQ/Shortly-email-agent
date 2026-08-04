-- Scrape starvation / stale-build watchdog.
--
-- WHY: on 2026-07-30 13:09 IST a stale copy of `scrape-news` was deployed over
-- the current one, reverting ~2 weeks of scraper work (48-source registry ->
-- 16 hardcoded feeds, 120 cap -> 50, per-source cap -> none). Nothing looked
-- broken: pg_cron reported "succeeded" (it only proves the HTTP call was
-- queued), the function kept returning 200, and articles kept trickling in
-- from the two highest-weighted feeds. Daily intake decayed 196 -> 4 general
-- articles/day over five days, and the only visible symptom was the
-- 2026-08-04 newsletter going out with 2 stories instead of 5.
--
-- shortly_pipeline_watchdog() self-heals summarize/cluster/curate but assumes
-- the pool is being filled, so it never noticed. This adds the missing check.
-- It is deliberately a SEPARATE function so that working self-healer is left
-- untouched.
--
-- Four signals. Verified by replaying them against the real outage data:
--   1. nothing scraped in 6h        -> outright death (would NOT have caught
--      this incident: the pipeline limped rather than stopped)
--   2. 24h volume < 40% of the      -> would have fired 08-01, 08-02, 08-03,
--      trailing 7-day median           i.e. 3 days before the bad email
--   3. sources.last_success_at      -> THE signal for this class of bug: an old
--      stale > 6h                      build answers 200 but never writes the
--                                      registry. Frozen from 07-30 12:30
--                                      onwards, so it fires ~6h after the
--                                      bad deploy.
--   4. general pool < 5 at 08:00 IST-> last line of defence, one hour before
--                                      the send.
--
-- Silent while healthy (verified: 3 runs on a healthy pipeline wrote 0 rows),
-- so pipeline_log stays readable.

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
    problems := problems || 'no articles scraped in 6h';
  end if;

  -- 2. Degraded intake. Guarded so it stays quiet on a young or genuinely
  --    low-volume pipeline.
  if baseline_daily >= 50 and fresh_24h < (baseline_daily * 0.4)::int then
    problems := problems || format('scrape volume %s in 24h vs typical %s/day',
                                   fresh_24h, baseline_daily);
  end if;

  -- 3. The reverted-deploy signal.
  if stale_health_mins > 360 then
    problems := problems || ('source health stale ' || stale_health_mins
                             || 'm - scraper may be a reverted/old build');
  end if;

  -- 4. Last line of defence, only in the hour before the send.
  if ist_hour = 8 and general_today < 5 then
    problems := problems || ('general pool only ' || general_today || ' before the 09:00 send');
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

-- Hourly at :50. A few cheap counts that return immediately when healthy; the
-- :50 slot keeps it clear of the existing watchdogs (:15/:45) and the
-- scrape/summarize/curate jobs.
select cron.schedule(
  'shortly-scrape-watchdog',
  '50 * * * *',
  $job$ select public.shortly_scrape_watchdog(); $job$
);

-- How to read it:
--   select at, detail from public.pipeline_log
--    where check_name = 'scrape-watchdog' order by at desc limit 20;
