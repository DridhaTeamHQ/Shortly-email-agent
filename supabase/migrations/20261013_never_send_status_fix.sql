-- Fix: a send blocked by SES Auto Validation was ALSO recorded as a hard bounce.
--
-- SES reports an Auto Validation block as a Permanent bounce (bounceSubType
-- EmailValidationSuppressed). Our email_events trigger correctly records it as
-- ses_auto_validation and marks the subscriber invalid -- but the email-events
-- webhook then sets status 'bounced' for every Permanent bounce, and the status
-- trigger turns 'bounced' into a hard_bounce entry. The address was never
-- delivered to, so "hard-bounce" is wrong (and double-counts it).
--
-- An address already blocked by SES validation or by our pre-check stays
-- 'invalid' when something tries to mark it 'bounced'.

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
  elsif new.status = 'bounced'
    and exists (select 1 from public.email_suppressions
                where email = lower(new.email)
                  and reason in ('ses_auto_validation', 'ses_medium_confidence', 'ses_low_confidence',
                                 'precheck_domain', 'precheck_validity'))
    and not exists (select 1 from public.email_events
                    where lower(email) = lower(new.email) and event_type = 'bounce' and bounce_type = 'Permanent'
                      and coalesce(bounce_sub, '') not in ('EmailValidationSuppressed', 'OnAccountSuppressionList', 'Suppressed')) then
    new.status := 'invalid';
  end if;
  return new;
end;
$$;

-- Clean up the addresses this already happened to (blocked, never delivered).
delete from public.email_suppressions x
where x.reason = 'hard_bounce'
  and exists (select 1 from public.email_suppressions y
              where y.email = x.email and y.reason in ('ses_auto_validation', 'ses_medium_confidence', 'ses_low_confidence'))
  and not exists (select 1 from public.email_events e
                  where lower(e.email) = x.email and e.event_type = 'bounce' and e.bounce_type = 'Permanent'
                    and coalesce(e.bounce_sub, '') not in ('EmailValidationSuppressed', 'OnAccountSuppressionList', 'Suppressed'));

update public.subscribers s
set status = 'invalid', updated_at = now()
where s.status = 'bounced'
  and exists (select 1 from public.email_suppressions y
              where y.email = lower(s.email) and y.reason in ('ses_auto_validation', 'ses_medium_confidence', 'ses_low_confidence'))
  and not exists (select 1 from public.email_events e
                  where lower(e.email) = lower(s.email) and e.event_type = 'bounce' and e.bounce_type = 'Permanent'
                    and coalesce(e.bounce_sub, '') not in ('EmailValidationSuppressed', 'OnAccountSuppressionList', 'Suppressed'));
