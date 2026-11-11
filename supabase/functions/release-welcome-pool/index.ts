// release-welcome-pool: once a day (cron 12:00 IST) takes the next addresses
// from welcome_pool and runs the normal daily-batch upload on them, so a bulk
// list the owner gives once goes out a set number per day with nobody's
// computer on (owner, 2026-11-11).
//
//   POST {}                 release today's share
//   POST {"dry_run": true}  only report what would be released
//
// Today's share = welcome_pool_settings.daily_limit minus what today's batch
// already holds (a file uploaded by hand the same day counts too), so a manual
// run or a second cron call never doubles the day. The upload itself is the
// subscribers import-batch action: Gmail-only and other pre-checks, never-send,
// already-known, the automatic SES validation and the DAILY_BATCH_MAX cap all
// apply exactly as for an upload through Claude or the dashboard.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { istDate } from "../_shared/report-mail.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const denied = await requireAgent(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const dryRun = body?.dry_run === true;
  const url = requiredEnv("SUPABASE_URL"), key = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(url, key);
  const today = istDate(0);

  try {
    const { data: settings } = await supabase.from("welcome_pool_settings").select("daily_limit").eq("id", true).maybeSingle();
    const dailyLimit = Number(settings?.daily_limit ?? 250);
    const { data: batch } = await supabase.from("subscriber_groups").select("added_count")
      .eq("is_daily_batch", true).eq("received_on", today).maybeSingle();
    const alreadyToday = Number(batch?.added_count ?? 0);
    const { count: waiting } = await supabase.from("welcome_pool").select("email", { count: "exact", head: true }).is("released_on", null);
    const room = Math.max(0, dailyLimit - alreadyToday);

    const summary = { today, daily_limit: dailyLimit, already_added_today: alreadyToday, waiting: waiting ?? 0, releasing: 0 };
    if (room === 0 || !waiting) return json({ ...summary, note: room === 0 ? "Today's limit is already reached." : "The pool is empty." });

    const { data: rows, error } = await supabase.from("welcome_pool").select("email,full_name")
      .is("released_on", null).order("added_at").order("email").limit(room);
    if (error) throw new Error(error.message);
    summary.releasing = rows?.length ?? 0;
    if (dryRun || !rows?.length) return json({ ...summary, dry_run: dryRun, emails: (rows ?? []).map((r) => r.email) });

    // Mark first, so a retry or overlapping call can never send the same rows twice.
    const emails = rows.map((r) => r.email);
    const { error: markErr } = await supabase.from("welcome_pool").update({ released_on: today }).in("email", emails);
    if (markErr) throw new Error(markErr.message);

    const res = await fetch(`${url}/functions/v1/subscribers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, apikey: key },
      body: JSON.stringify({ action: "import-batch", received_on: today, subscribers: rows.map((r) => ({ email: r.email, full_name: r.full_name })) }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Nothing was added: put them back so tomorrow's run picks them up.
      await supabase.from("welcome_pool").update({ released_on: null }).in("email", emails);
      throw new Error(`import-batch failed: ${result?.error ?? res.status}`);
    }
    // SES could not rate these today: back in the pool for the next run.
    const unchecked: string[] = Array.isArray(result?.ses_unchecked) ? result.ses_unchecked : [];
    if (unchecked.length) await supabase.from("welcome_pool").update({ released_on: null }).in("email", unchecked);
    console.log(JSON.stringify({ tag: "release-welcome-pool", ...summary, added: result.added, ses_rejected: result.ses_rejected, back_in_pool: unchecked.length }));
    return json({ ...summary, ok: true, upload: result });
  } catch (e) {
    console.error(JSON.stringify({ tag: "release-welcome-pool", error: String(e).slice(0, 300) }));
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
