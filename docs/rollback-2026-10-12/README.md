# Rolling back the 2026-10-12 daily-batch changes

Everything below was made live on 2026-10-12. Before that, the code was git
commit `69c2517`, except two files whose live version had drifted from git;
their pre-change live copies are saved next to this file.

## Stop sending first (safe, instant, reversible)

```sql
-- Pause automatic welcome emails
select cron.unschedule('shortly-send-welcomes');
-- Put the newsletter drain back to its old shape
select cron.unschedule('shortly-drain-outbox-late');
select cron.schedule('shortly-drain-outbox', '32-59 3 * * *',
  $$ select public.invoke_edge('send-newsletter', '{"drain":true,"limit":150}'::jsonb, 180000); $$);
```

```bash
# Old newsletter cap (50 per run)
npx supabase secrets set SEND_MAX_PER_RUN=50 --project-ref ygxdrphajvrbjcaxhvcn
```

## Restore the previous function code

| Function | Previous live version |
|---|---|
| subscribers, send-newsletter, welcome-email, mailer | git `69c2517` |
| `_shared/send-guard.ts` | `send-guard.live-before.ts` (this folder) |
| ses-diagnose | `ses-diagnose.live-before.ts` (this folder) |
| send-welcomes, welcome-test | new — delete or leave unscheduled |

Restore the files, then `npx supabase functions deploy <name> --project-ref ygxdrphajvrbjcaxhvcn --use-api`.

## Database

The new columns, tables and functions are additive and harmless when unused.
Only remove them if asked; the never-send list (`email_suppressions`) should be
kept — dropping it would let bounced addresses be mailed again.

To fully undo: drop triggers `subscribers_enforce_suppression`,
`subscribers_record_suppression`, `email_events_record_suppression`; restore
`claim_email_batch` without the suppression check (definition in
`20261012_email_suppressions.sql`, minus the `not exists` line).

## Not code (done in the AWS console, 2026-10-12)

SES Auto Validation was enabled (account level, SES managed). To undo:
SES → Email validation → Auto Validation → Edit → untick Enabled → Save.
