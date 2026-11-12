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
    // Self-heal (12 Nov): import-batch can outlive the 150 s gateway timeout
    // (504) and still add everyone. Before choosing today's rows:
    //   * pool rows already on the subscriber or never-send list -> released
    //   * rows released on an EARLIER day that never got added -> back in pool
    const { error: healErr } = await supabase.rpc("welcome_pool_reconcile", { p_today: today });
    if (healErr) throw new Error(`reconcile: ${healErr.message}`);

    const { data: settings } = await supabase.from("welcome_pool_settings").select("daily_limit").eq("id", true).maybeSingle();
    const dailyLimit = Number(settings?.daily_limit ?? 250);
    const { data: batch } = await supabase.from("subscriber_groups").select("added_count")
      .eq("is_daily_batch", true).eq("received_on", today).maybeSingle();
    const alreadyToday = Number(batch?.added_count ?? 0);
    const { count: waiting } = await supabase.from("welcome_pool").select("email", { count: "exact", head: true }).is("released_on", null);
    // Never past DAILY_BATCH_MAX: import-batch would refuse the rest, and those
    // would be marked released without being added.
    const cap = Number(Deno.env.get("DAILY_BATCH_MAX")) || 2500;
    // At most CHUNK per call, so one upload (SES check ~0.7 s per address)
    // finishes well inside the 150 s gateway timeout. The cron calls again
    // every 10 minutes from 12:00 until today's limit is filled.
    const CHUNK = 120;
    const room = Math.min(CHUNK, Math.max(0, Math.min(dailyLimit, cap) - alreadyToday));

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
      // The hosted SUPABASE_SERVICE_ROLE_KEY is not a JWT, so requireAgent()
      // cannot read a role from it (12 Nov release was refused): send the agent
      // token as well, which requireAgent() accepts.
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        apikey: key,
        "x-agent-token": Deno.env.get("SHORTLY_AGENT_SHARED_TOKEN")?.trim() ?? "",
      },
      body: JSON.stringify({ action: "import-batch", received_on: today, subscribers: rows.map((r) => ({ email: r.email, full_name: r.full_name })) }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 504 = the upload is still running in the background (12 Nov): leave
      // the rows released; the next run's reconcile fixes any that were not
      // added. Any other failure: nothing was added, put them back now.
      if (res.status !== 504) await supabase.from("welcome_pool").update({ released_on: null }).in("email", emails);
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
