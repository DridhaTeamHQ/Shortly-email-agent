-- Never-send reason for the owner's rule (2026-11-05): an address is mailed
-- only when SES overall validity is HIGH and the mailbox check is HIGH or
-- MEDIUM. import-batch puts "overall HIGH, mailbox LOW" here.
alter table public.email_suppressions drop constraint if exists email_suppressions_reason_check;
alter table public.email_suppressions add constraint email_suppressions_reason_check check (reason in (
  'hard_bounce', 'complaint', 'repeated_soft_bounce', 'unsubscribed', 'manual',
  'precheck_domain', 'precheck_validity',
  'ses_auto_validation', 'ses_medium_confidence', 'ses_low_confidence', 'ses_mailbox_low'
));
