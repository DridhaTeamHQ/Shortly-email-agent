-- Slower sending, for Gmail inbox placement (2026-10-14).
--
-- Gmail distrusts bursts from a domain it is still learning: on 2026-10-12
-- (2,000+ welcomes in an hour) Postmaster showed "Suspected spam" temp
-- failures, and the 2026-10-14 newsletter went out at ~400/min (5,176 in 19
-- minutes). Same mail, same 09:00 IST start, spread out:
--
--   newsletter drain: 500 -> 60 per minute. The window (03:32-05:59 UTC,
--     148 calls) holds ~8,880 sends, so ~5,300 finish by ~10:30 IST.
--   welcomes: 200 -> 40 per 10-minute run = ~240 an hour.
--
-- cron.schedule with an existing job name replaces that job's command.
-- Undo: re-run 20261012_schedule_daily_batches.sql.

select cron.schedule('shortly-drain-outbox', '32-59 3 * * *',
  $$ select public.invoke_edge('send-newsletter', '{"drain":true,"limit":60}'::jsonb, 180000); $$);
select cron.schedule('shortly-drain-outbox-late', '* 4-5 * * *',
  $$ select public.invoke_edge('send-newsletter', '{"drain":true,"limit":60}'::jsonb, 180000); $$);
select cron.schedule('shortly-send-welcomes', '*/10 0-2,6-23 * * *',
  $$ select public.invoke_edge('send-welcomes', '{"limit":40}'::jsonb, 150000); $$);
