-- Daily report email (stats-report kind=daily) to REPORT_EMAIL_TO, with the
-- day's never-send list attached. 06:05 UTC = 11:35 IST: after the newsletter
-- window (plan 09:00, drain until 11:29 IST) has closed, so the numbers cover
-- the whole send. Welcome reports are sent by send-welcomes, not by cron.
select cron.schedule('shortly-daily-report', '5 6 * * *',
  $$ select public.invoke_edge('stats-report', '{"kind":"daily"}'::jsonb, 150000); $$);
