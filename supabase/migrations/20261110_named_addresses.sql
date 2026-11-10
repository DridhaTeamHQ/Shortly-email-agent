-- Named domain mails: non-Gmail addresses the owner adds personally (dashboard
-- "Domain mails" box, admin password). Mail to them goes through the SES
-- configuration set in SES_NAMED_CONFIGURATION_SET (Domain-mails, Auto
-- Validation off), and they skip the newsletter domain hold. Owner rule
-- 2026-11-07: mailbox exists MEDIUM/HIGH is fine; overall LOW or mailbox LOW
-- needs the owner's explicit approval, recorded in approved_override.
-- The ALLOWED_EMAIL_ADDRESSES secret still counts as named too (older list).
create table if not exists public.named_addresses (
  email text primary key check (email = lower(email)),
  ses_overall text,
  ses_mailbox text,
  approved_override boolean not null default false,
  note text,
  added_by text not null default 'dashboard',
  added_at timestamptz not null default now()
);

alter table public.named_addresses enable row level security;
revoke all on public.named_addresses from anon, authenticated;

insert into public.named_addresses (email, ses_overall, ses_mailbox, approved_override, note, added_by, added_at) values
  ('kiran1kumar5@yahoo.com', null, null, false, 'Owner-named exception (Oct 2026)', 'owner', '2026-10-13'),
  ('sujeeth@tamadamedia.com', null, null, false, 'Owner-named exception (Oct 2026)', 'owner', '2026-10-17'),
  ('balaji.g@tamadamedia.in', 'MEDIUM', 'LOW', true, 'Owner approved despite mailbox LOW (real mailbox)', 'owner', '2026-11-10')
on conflict (email) do nothing;
