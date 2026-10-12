-- Daily batch enrolment.
--
-- A batch is a subscriber_group with is_daily_batch = true. Each day's upload
-- becomes one batch: its members get a welcome email the same day (sent by the
-- send-welcomes function from a queue), and join the daily newsletter from the
-- IST day AFTER their welcome actually went out.
--
-- Eligibility lives on the subscriber, not the batch, so an address that turns
-- up in several files is enrolled once, by the first batch that added it.

alter table public.subscriber_groups
  add column if not exists is_daily_batch boolean not null default false,
  add column if not exists received_on date,
  add column if not exists rows_in_file integer not null default 0,
  add column if not exists added_count integer not null default 0,
  add column if not exists duplicate_count integer not null default 0,
  add column if not exists invalid_count integer not null default 0,
  add column if not exists already_known_count integer not null default 0,
  add column if not exists suppressed_count integer not null default 0;

alter table public.subscribers
  -- Set by a daily-batch import: this address is owed a welcome email.
  -- NULL for everyone enrolled any other way (site form, manual add, legacy).
  add column if not exists welcome_requested_at timestamptz,
  add column if not exists welcome_claimed_at timestamptz,
  add column if not exists welcome_attempts integer not null default 0,
  add column if not exists welcome_error text,
  -- First IST date this subscriber may receive the newsletter. Written by
  -- send-welcomes when the welcome is sent (send date + 1). A batch member with
  -- no newsletter_from yet has not been welcomed and is not eligible.
  add column if not exists newsletter_from date;

create index if not exists subscribers_welcome_queue_idx
  on public.subscribers (welcome_requested_at, id)
  where welcome_requested_at is not null and welcome_sent_at is null;

-- Claim the next welcome emails to send. FOR UPDATE SKIP LOCKED plus the
-- claimed_at lease means two overlapping cron runs can never pick the same
-- person, and a run that dies mid-way releases its rows after p_stale_minutes.
create or replace function public.claim_welcome_batch(p_limit integer default 200, p_stale_minutes integer default 15)
returns table (id uuid, email text, full_name text)
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
begin
  return query
  with claimed as (
    select s.id
    from public.subscribers s
    where s.welcome_requested_at is not null
      and s.welcome_sent_at is null
      and s.status = 'subscribed'
      and s.verification_status = 'valid'
      and s.welcome_attempts < 3
      and (s.welcome_claimed_at is null
           or s.welcome_claimed_at < now() - make_interval(mins => p_stale_minutes))
    order by s.welcome_requested_at, s.id
    limit greatest(1, least(500, p_limit))
    for update skip locked
  )
  update public.subscribers s
  set welcome_claimed_at = now(),
      welcome_attempts = s.welcome_attempts + 1
  from claimed c
  where s.id = c.id
  returning s.id, s.email, s.full_name;
end;
$$;

revoke all on function public.claim_welcome_batch(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_welcome_batch(integer, integer) to service_role;

-- Add one upload's counts to its batch. Several files can land in the same
-- day's batch, so counts accumulate rather than overwrite.
create or replace function public.bump_batch_counts(
  p_batch_id uuid, p_rows integer, p_added integer, p_duplicates integer,
  p_invalid integer, p_already_known integer, p_suppressed integer default 0
) returns void
language sql
security definer
set search_path to 'public', 'pg_catalog'
as $$
  update public.subscriber_groups
  set rows_in_file = rows_in_file + greatest(0, p_rows),
      added_count = added_count + greatest(0, p_added),
      duplicate_count = duplicate_count + greatest(0, p_duplicates),
      invalid_count = invalid_count + greatest(0, p_invalid),
      already_known_count = already_known_count + greatest(0, p_already_known),
      suppressed_count = suppressed_count + greatest(0, p_suppressed)
  where id = p_batch_id and is_daily_batch;
$$;

revoke all on function public.bump_batch_counts(uuid, integer, integer, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.bump_batch_counts(uuid, integer, integer, integer, integer, integer, integer) to service_role;

-- One row per daily batch: upload counts, welcome progress, newsletter start,
-- and how its members are doing now. Read by the dashboard and the agent.
create or replace view public.daily_batch_status
with (security_invoker = true) as
select
  g.id as batch_id,
  g.name,
  g.received_on,
  g.rows_in_file,
  g.added_count,
  g.duplicate_count,
  g.invalid_count,
  g.already_known_count,
  g.suppressed_count,
  count(s.id) as members,
  count(s.id) filter (where s.welcome_sent_at is not null) as welcome_sent,
  count(s.id) filter (where s.welcome_sent_at is null and s.status = 'subscribed'
                        and s.verification_status = 'valid' and s.welcome_attempts < 3) as welcome_pending,
  count(s.id) filter (where s.welcome_sent_at is null and s.welcome_attempts >= 3) as welcome_failed,
  count(s.id) filter (where s.verification_status <> 'valid') as held_unverified,
  min(s.newsletter_from) as newsletter_from,
  count(s.id) filter (where s.status = 'subscribed' and s.newsletter_from is not null) as newsletter_enrolled,
  count(s.id) filter (where s.status = 'unsubscribed') as unsubscribed,
  count(s.id) filter (where s.status = 'bounced') as bounced
from public.subscriber_groups g
left join public.subscriber_group_members m on m.group_id = g.id
left join public.subscribers s on s.id = m.subscriber_id
where g.is_daily_batch
group by g.id;

revoke all on public.daily_batch_status from anon, authenticated;
grant select on public.daily_batch_status to service_role;
