// send-welcomes: drains the daily-batch welcome queue.
//
// A daily-batch import marks each new address with welcome_requested_at. This
// function, run by cron every few minutes, claims the next slice of those
// people, sends each one the welcome email, and on success stamps
// welcome_sent_at plus newsletter_from = tomorrow (IST) -- which is what lets
// the next morning's newsletter include them, and no earlier.
//
//   POST {}                  -> send up to DEFAULT_LIMIT queued welcomes
//   POST {limit: 100}        -> smaller/bigger slice (capped at MAX_LIMIT)
//   POST {dry_run: true}     -> report the queue and the brakes; send nothing
//
// Safety: the bounce/complaint brake is checked before every slice, so a bad
// batch stops itself after at most one slice. Rows are claimed with a lease
// (claim_welcome_batch), so overlapping runs never double-send, and a failed
// send is retried on a later run, at most three attempts in all.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { checkBounceRate } from "../_shared/send-guard.ts";
import { sendWelcomeEmail } from "../_shared/welcome-send.ts";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
// Concurrent sends. Kept well under the SES rate (14/s) so a welcome slice
// never pushes a send into throttling -- a throttled send falls back to Brevo,
// which is not authenticated for this domain.
const GROUP = 5;

function istDate(offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" })
    .format(new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000));
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const denied = await requireAgent(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(body?.limit) || DEFAULT_LIMIT));
  const dryRun = body?.dry_run === true;
  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  const { count: queued, error: queueErr } = await supabase
    .from("subscribers")
    .select("id", { count: "exact", head: true })
    .not("welcome_requested_at", "is", null)
    .is("welcome_sent_at", null)
    .eq("status", "subscribed")
    .eq("verification_status", "valid")
    .lt("welcome_attempts", 3);
  if (queueErr) return json({ error: queueErr.message }, 500);

  const brake = await checkBounceRate(supabase);
  if (!brake.ok) {
    console.error(JSON.stringify({ tag: "send-welcomes", paused: true, reason: brake.reason }));
    return json({
      paused: true,
      reason: brake.reason,
      bounce_rate_pct: brake.rate,
      complaint_rate_pct: brake.complaintRate ?? null,
      queued: queued ?? 0,
    }, 409);
  }
  if (dryRun) {
    return json({ dry_run: true, queued: queued ?? 0, would_send: Math.min(limit, queued ?? 0), brake });
  }
  if (!queued) return json({ claimed: 0, sent: 0, failed: 0, queued: 0 });

  const { data: claimed, error: claimErr } = await supabase
    .rpc("claim_welcome_batch", { p_limit: limit, p_stale_minutes: 15 });
  if (claimErr) return json({ error: claimErr.message }, 500);
  const rows = (claimed ?? []) as Array<{ id: string; email: string; full_name: string | null }>;

  const newsletterFrom = istDate(1);
  const sentIds: string[] = [];
  const viaFallback: string[] = [];
  const failures: Array<{ id: string; email: string; error: string }> = [];
  for (let i = 0; i < rows.length; i += GROUP) {
    await Promise.all(rows.slice(i, i + GROUP).map(async (row) => {
      try {
        const result = await sendWelcomeEmail(row.email, row.full_name);
        if (result.ok) {
          // A Brevo fallback still delivered the mail, so it counts as sent --
          // retrying would be a second welcome. It is reported, because Brevo
          // is not authenticated for this domain and those copies risk spam.
          sentIds.push(row.id);
          if (result.provider !== "ses") viaFallback.push(row.email);
        } else {
          failures.push({ id: row.id, email: row.email, error: result.error ?? "provider rejected the message" });
        }
      } catch (error) {
        failures.push({ id: row.id, email: row.email, error: error instanceof Error ? error.message : String(error) });
      }
    }));
  }

  if (sentIds.length > 0) {
    const { error } = await supabase
      .from("subscribers")
      .update({
        welcome_sent_at: new Date().toISOString(),
        newsletter_from: newsletterFrom,
        welcome_error: null,
        welcome_claimed_at: null,
      })
      .in("id", sentIds);
    // The mail is already out; a failed stamp would re-send it on the next run
    // once the lease expires. Surface it loudly rather than swallow it.
    if (error) {
      console.error(JSON.stringify({ tag: "send-welcomes", stamp_failed: true, error: error.message, ids: sentIds.length }));
      return json({ error: `sent ${sentIds.length} but could not record it: ${error.message}` }, 500);
    }
  }
  for (const f of failures) {
    await supabase
      .from("subscribers")
      .update({ welcome_error: f.error.slice(0, 500), welcome_claimed_at: null })
      .eq("id", f.id);
  }

  console.log(JSON.stringify({
    tag: "send-welcomes", claimed: rows.length, sent: sentIds.length, failed: failures.length,
    via_fallback: viaFallback.length, newsletter_from: newsletterFrom,
  }));
  return json({
    claimed: rows.length,
    sent: sentIds.length,
    failed: failures.length,
    sent_via_fallback: viaFallback.slice(0, 20),
    failures: failures.slice(0, 20).map(({ email, error }) => ({ email, error })),
    newsletter_from: newsletterFrom,
    queued_after: Math.max(0, (queued ?? 0) - sentIds.length),
  });
});
