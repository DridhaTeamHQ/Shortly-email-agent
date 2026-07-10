-- Make scheduled newsletter idempotency atomic.
-- The application lookup protects normal retries; this unique key protects
-- two cron/manual requests that start at the same time.
alter table public.digests
  add column if not exists scheduled_key text;

create unique index if not exists digests_scheduled_key_unique
  on public.digests (scheduled_key)
  where scheduled_key is not null;
