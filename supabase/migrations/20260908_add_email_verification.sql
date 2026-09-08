-- Email verification: catch unworking addresses BEFORE sending to them.
--
-- The email-events webhook already suppresses addresses AFTER a hard bounce,
-- but every bad address still costs one wasted send and hurts sender
-- reputation first. This adds pre-send verification:
--   * verification_status  -- unverified | valid | risky | invalid
--   * verified_at          -- when the last check ran
--   * verification_reason  -- human-readable reason for the verdict
--   * status 'invalid'     -- verified-dead addresses; every send path
--                             filters on status='subscribed', so flagging
--                             removes them from all sends with no send-path
--                             change (same trick email-events uses for
--                             'bounced').
--
-- 'risky' (role accounts, no-MX-but-resolvable domains, transient DNS
-- failures) stays subscribed: it is a signal for the dashboard, not a
-- suppression. Only 'invalid' (bad syntax, disposable domain, NXDOMAIN)
-- is removed from sends.

alter table public.subscribers
  drop constraint if exists subscribers_status_check;
alter table public.subscribers
  add constraint subscribers_status_check
  check (status in ('subscribed', 'unsubscribed', 'bounced', 'invalid'));

alter table public.subscribers
  add column if not exists verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'valid', 'risky', 'invalid')),
  add column if not exists verified_at timestamptz,
  add column if not exists verification_reason text;

-- The batch verifier repeatedly asks "who is still unverified?".
create index if not exists subscribers_verification_status_idx
  on public.subscribers (verification_status)
  where verification_status = 'unverified';
