-- Daily technical work report (owner, 2026-11-12), sent by the server at
-- 7:00 PM IST so it works with every computer and Claude turned off.
--
--   work_report_days  one row per IST day: the day's report notes (JSON,
--                     same shape as docs/work-log/*.json), written during the
--                     day's Claude sessions; sent_at/message_id once mailed
--   cron 13:30 UTC (19:00 IST) -> edge fn work-report: adds live numbers,
--   builds the email (flow charts as boxes) + Excel, sends ONLY to the owner
--   (the WORK_REPORT_TO secret only), once per day.
create table if not exists public.work_report_days (
  day date primary key,
  report jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  message_id text
);
alter table public.work_report_days enable row level security;
revoke all on public.work_report_days from anon, authenticated;

select cron.schedule(
  'shortly-work-report',
  '30 13 * * *',
  $$ select public.invoke_edge('work-report', '{}'::jsonb, 150000); $$
);
