-- The inline pipeline already fact-checks new content. Disable the old
-- recurring backfill so it cannot consume credits every morning.
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'shortly-backfill-fact-scores') then
    perform cron.unschedule('shortly-backfill-fact-scores');
  end if;
end
$do$;
