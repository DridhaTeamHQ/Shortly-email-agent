-- Schedules for daily-batch enrolment. Applied at go-live, after
-- 20261012_daily_batches.sql and the send-welcomes deploy.
--
-- Newsletter window (UTC 03:30-05:59 = 09:00-11:29 IST): plan at 03:30, drain
-- every minute from 03:32. 500 per drain call is ~8/s, under the SES 14/s
-- limit, and ~148 calls give room for ~74k sends -- more than the 50k/day quota.
-- The drain must not start before 03:30: until the plan runs, yesterday's
-- unsent rows are still 'queued' and the plan is what retires them.
select cron.schedule('shortly-drain-outbox', '32-59 3 * * *',
  $$ select public.invoke_edge('send-newsletter', '{"drain":true,"limit":500}'::jsonb, 180000); $$);
select cron.schedule('shortly-drain-outbox-late', '* 4-5 * * *',
  $$ select public.invoke_edge('send-newsletter', '{"drain":true,"limit":500}'::jsonb, 180000); $$);

-- Welcome emails every 10 minutes, OUTSIDE the newsletter window so the two
-- never compete for the SES rate. 200 per run covers a 2,500 batch in ~2 hours.
select cron.schedule('shortly-send-welcomes', '*/10 0-2,6-23 * * *',
  $$ select public.invoke_edge('send-welcomes', '{}'::jsonb, 150000); $$);
