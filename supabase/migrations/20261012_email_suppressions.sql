-- Permanent "never send" list.
--
-- subscribers.status already goes to 'bounced' / 'unsubscribed' when SES
-- reports a hard bounce or complaint -- but that memory lived on the row, so
-- deleting the row (or re-importing the address) forgot it. This table keeps
-- just the address and why, survives deletes, and every send path checks it:
-- batch import, welcome queue, newsletter plan, newsletter drain.
--
-- Applied after 20261012_daily_batches.sql (it redefines claim_welcome_batch).

create table if not exists public.email_suppressions (
  email text not null check (email = lower(email)),
  reason text not null check (reason in (
    'hard_bounce',          -- SES Permanent bounce (includes its own suppression-list bounces)
    'complaint',            -- marked as spam
    'repeated_soft_bounce', -- 5+ temporary bounces in 14 days and nothing delivered
    'unsubscribed',         -- opted out; cleared if they opt back in themselves
    'manual'                -- added by the team
  )),
  detail text,
  source text not null default 'system',
  created_at timestamptz not null default now(),
  primary key (email, reason)
);

alter table public.email_suppressions enable row level security;
create policy "Service role can manage email suppressions"
  on public.email_suppressions for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create index if not exists email_events_email_lower_idx on public.email_events (lower(email), received_at);
create index if not exists subscribers_email_lower_idx on public.subscribers (lower(email));

-- ---- Pre-check: a suppressed address can never be (re)activated ----------
-- Any write that would make a hard-suppressed address 'subscribed' (an import,
-- a manual add, the site form) is turned back to bounced/unsubscribed. An
-- 'unsubscribed' entry alone does not block: a person may opt back in.
create or replace function public.subscribers_enforce_suppression()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
declare
  hard_reason text;
begin
  if new.status = 'subscribed' then
    select reason into hard_reason
    from public.email_suppressions
    where email = lower(new.email) and reason <> 'unsubscribed'
    order by (reason = 'complaint') desc
    limit 1;
    if hard_reason = 'complaint' then
      new.status := 'unsubscribed';
      new.unsubscribed_at := coalesce(new.unsubscribed_at, now());
    elsif hard_reason is not null then
      new.status := 'bounced';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists subscribers_enforce_suppression on public.subscribers;
create trigger subscribers_enforce_suppression
  before insert or update of status, email on public.subscribers
  for each row execute function public.subscribers_enforce_suppression();

-- Record status changes made anywhere (dashboard, unsubscribe link, webhook).
create or replace function public.subscribers_record_suppression()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return null;
  end if;
  if new.status = 'unsubscribed' then
    insert into public.email_suppressions (email, reason, source)
    values (lower(new.email), 'unsubscribed', 'subscribers') on conflict do nothing;
  elsif new.status = 'bounced' then
    insert into public.email_suppressions (email, reason, source)
    values (lower(new.email), 'hard_bounce', 'subscribers') on conflict do nothing;
  elsif new.status = 'subscribed' and tg_op = 'UPDATE' and old.status = 'unsubscribed' then
    -- They opted back in. Hard reasons stay (the BEFORE trigger enforces them).
    delete from public.email_suppressions where email = lower(new.email) and reason = 'unsubscribed';
  end if;
  return null;
end;
$$;

drop trigger if exists subscribers_record_suppression on public.subscribers;
create trigger subscribers_record_suppression
  after insert or update of status on public.subscribers
  for each row execute function public.subscribers_record_suppression();

-- ---- Post-check: every SES bounce/complaint lands here immediately --------
create or replace function public.email_events_record_suppression()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
declare
  addr text := lower(new.email);
begin
  if addr is null or addr = '' then
    return null;
  end if;
  if new.event_type = 'bounce' and new.bounce_type = 'Permanent' then
    insert into public.email_suppressions (email, reason, detail, source)
    values (addr, 'hard_bounce', new.bounce_sub, 'ses-event') on conflict do nothing;
    update public.subscribers set status = 'bounced', updated_at = now()
    where lower(email) = addr and status = 'subscribed';
  elsif new.event_type = 'complaint' then
    insert into public.email_suppressions (email, reason, source)
    values (addr, 'complaint', 'ses-event') on conflict do nothing;
    update public.subscribers set status = 'unsubscribed', unsubscribed_at = now(), updated_at = now()
    where lower(email) = addr and status = 'subscribed';
  elsif new.event_type = 'bounce' then
    -- Temporary bounces (mailbox full, server busy) are retried by SES; only a
    -- run of them with nothing delivered means the inbox is effectively dead.
    if (select count(*) from public.email_events
        where lower(email) = addr and event_type = 'bounce'
          and coalesce(bounce_type, '') <> 'Permanent'
          and received_at > now() - interval '14 days') >= 5
       and not exists (select 1 from public.email_events
        where lower(email) = addr and event_type = 'delivery'
          and received_at > now() - interval '14 days') then
      insert into public.email_suppressions (email, reason, detail, source)
      values (addr, 'repeated_soft_bounce', new.bounce_sub, 'ses-event') on conflict do nothing;
      update public.subscribers set status = 'bounced', updated_at = now()
      where lower(email) = addr and status = 'subscribed';
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists email_events_record_suppression on public.email_events;
create trigger email_events_record_suppression
  after insert on public.email_events
  for each row execute function public.email_events_record_suppression();

-- ---- Welcome and newsletter claims skip suppressed addresses --------------
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
      and not exists (select 1 from public.email_suppressions x where x.email = lower(s.email))
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

-- Same as before plus the suppression check, so an address that bounces while
-- the morning queue is draining is not mailed later in that same drain. Rows
-- skipped this way stay queued and are retired by the next morning's plan.
create or replace function public.claim_email_batch(p_limit integer default 200, p_stale_minutes integer default 10)
returns setof public.email_outbox
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
begin
  return query
  with claimed as (
    select o.id
    from public.email_outbox o
    where o.scheduled_for <= now()
      and o.attempts < o.max_attempts
      and (
        o.status = 'queued'
        or (o.status = 'sending' and o.locked_at < now() - make_interval(mins => p_stale_minutes))
      )
      and not exists (select 1 from public.email_suppressions x where x.email = lower(o.email))
    order by o.scheduled_for, o.id
    limit greatest(1, least(1000, p_limit))
    for update skip locked
  )
  update public.email_outbox o
  set status = 'sending',
      locked_at = now(),
      attempts = o.attempts + 1
  from claimed c
  where o.id = c.id
  returning o.*;
end;
$$;

revoke all on function public.claim_email_batch(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_email_batch(integer, integer) to service_role;

-- ---- Backfill from what is already known ----------------------------------
insert into public.email_suppressions (email, reason, detail, source, created_at)
select lower(email), 'hard_bounce', max(bounce_sub), 'backfill:email_events', min(received_at)
from public.email_events
where event_type = 'bounce' and bounce_type = 'Permanent' and coalesce(email, '') <> ''
group by lower(email)
on conflict do nothing;

insert into public.email_suppressions (email, reason, source, created_at)
select lower(email), 'complaint', 'backfill:email_events', min(received_at)
from public.email_events
where event_type = 'complaint' and coalesce(email, '') <> ''
group by lower(email)
on conflict do nothing;

insert into public.email_suppressions (email, reason, detail, source)
select lower(b.email), 'repeated_soft_bounce', max(b.bounce_sub), 'backfill:email_events'
from public.email_events b
where b.event_type = 'bounce' and coalesce(b.bounce_type, '') <> 'Permanent'
  and b.received_at > now() - interval '14 days' and coalesce(b.email, '') <> ''
  and not exists (select 1 from public.email_events d
                  where lower(d.email) = lower(b.email) and d.event_type = 'delivery'
                    and d.received_at > now() - interval '14 days')
group by lower(b.email)
having count(*) >= 5
on conflict do nothing;

insert into public.email_suppressions (email, reason, source)
select lower(email), case status when 'unsubscribed' then 'unsubscribed' else 'hard_bounce' end, 'backfill:subscribers'
from public.subscribers
where status in ('unsubscribed', 'bounced')
on conflict do nothing;

-- Anyone still 'subscribed' despite a hard reason (e.g. the repeated soft
-- bounces above) is switched off now; the BEFORE trigger picks the status.
update public.subscribers s
set status = 'subscribed', updated_at = now()
where s.status = 'subscribed'
  and exists (select 1 from public.email_suppressions x where x.email = lower(s.email) and x.reason <> 'unsubscribed');
