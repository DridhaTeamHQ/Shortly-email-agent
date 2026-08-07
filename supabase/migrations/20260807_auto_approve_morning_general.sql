-- Schedule a focused morning approval pass for the General daily wrap.
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'shortly-auto-approve-morning-general') then
    perform cron.unschedule('shortly-auto-approve-morning-general');
  end if;
end
$do$;

select cron.schedule('shortly-auto-approve-morning-general', '40 1 * * *',
  $job$ select public.invoke_edge('auto-approve-general', '{"scheduled":true}'::jsonb, 300000); $job$);
