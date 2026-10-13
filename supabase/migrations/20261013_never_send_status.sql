-- Never-send list: say WHY an address is on it.
--
-- New reasons, so the owner can see the status of every blocked address:
--   precheck_domain        not an allowed domain (only @gmail.com is accepted)
--   precheck_validity      failed our pre-check (shared mailbox, impossible
--                          Gmail name, randomly typed, typo/disposable domain)
--   ses_auto_validation    SES Auto Validation (threshold HIGH) blocked a send;
--                          send-welcomes relabels it once SES says why:
--   ses_medium_confidence  SES overall validity MEDIUM
--   ses_low_confidence     SES overall validity LOW
--
-- Every reason except 'unsubscribed' blocks the address for good.

alter table public.email_suppressions drop constraint if exists email_suppressions_reason_check;
alter table public.email_suppressions add constraint email_suppressions_reason_check check (reason in (
  'hard_bounce', 'complaint', 'repeated_soft_bounce', 'unsubscribed', 'manual',
  'precheck_domain', 'precheck_validity',
  'ses_auto_validation', 'ses_medium_confidence', 'ses_low_confidence'
));

-- A blocked address that is somehow written as 'subscribed' is turned back:
-- complaints to unsubscribed, real bounces to bounced, everything else
-- (pre-check, SES validation, manual) to invalid.
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
    order by (reason = 'complaint') desc, (reason in ('hard_bounce', 'repeated_soft_bounce')) desc
    limit 1;
    if hard_reason = 'complaint' then
      new.status := 'unsubscribed';
      new.unsubscribed_at := coalesce(new.unsubscribed_at, now());
    elsif hard_reason in ('hard_bounce', 'repeated_soft_bounce') then
      new.status := 'bounced';
    elsif hard_reason is not null then
      new.status := 'invalid';
    end if;
  end if;
  return new;
end;
$$;

-- SES events. A send blocked by Auto Validation is not a bounce from a mailbox:
-- record it as ses_auto_validation (relabelled to medium/low confidence later)
-- and switch the subscriber to invalid. Everything else as before.
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
  if new.event_type = 'bounce' and new.bounce_sub = 'EmailValidationSuppressed' then
    insert into public.email_suppressions (email, reason, detail, source)
    values (addr, 'ses_auto_validation', 'Blocked by SES Auto Validation (below HIGH) before sending', 'ses-event')
    on conflict do nothing;
    update public.subscribers set status = 'invalid', verification_status = 'invalid',
      verification_reason = 'SES Auto Validation: below HIGH', updated_at = now()
    where lower(email) = addr and status = 'subscribed';
  elsif new.event_type = 'bounce' and new.bounce_type = 'Permanent' then
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

-- Relabel what is already there.
-- 1) 2026-10-13 domain cleanup, stored as 'manual' until this migration existed.
insert into public.email_suppressions (email, reason, detail, source, created_at)
select email, 'precheck_domain',
       'Not @gmail.com (' || split_part(email, '@', 2) || ')', source, created_at
from public.email_suppressions
where reason = 'manual' and detail like 'precheck-domain%'
on conflict do nothing;
delete from public.email_suppressions where reason = 'manual' and detail like 'precheck-domain%';

-- 2) Sends SES Auto Validation blocked before this migration (backfilled as hard_bounce).
insert into public.email_suppressions (email, reason, detail, source, created_at)
select email, 'ses_auto_validation', 'Blocked by SES Auto Validation before sending', source, created_at
from public.email_suppressions
where reason = 'hard_bounce' and detail = 'EmailValidationSuppressed'
on conflict do nothing;
delete from public.email_suppressions where reason = 'hard_bounce' and detail = 'EmailValidationSuppressed';
