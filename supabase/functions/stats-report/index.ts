// stats-report: emails the team a stats report (see _shared/stats-report.ts).
//
//   POST {"kind":"daily"}                      -> daily report + never-send Excel
//   POST {"kind":"daily","date":"2026-10-13"}  -> for that IST day
//   POST {"kind":"welcome","batch":"Batch 2026-10-13"} -> one batch's welcome report
//   add "dry_run":true                         -> the numbers only; nothing is sent
//   add "to":["a@b.com"]                        -> send to these instead of REPORT_EMAIL_TO
//
// Recipients: REPORT_EMAIL_TO secret (comma-separated). The daily report runs
// from cron after the morning newsletter has finished.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { istDate } from "../_shared/report-mail.ts";
import { sendDailyReport, sendWelcomeReport } from "../_shared/stats-report.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const denied = await requireAgent(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const dryRun = body?.dry_run === true;
  const toOverride = (Array.isArray(body?.to) ? body.to : body?.to ? [body.to] : [])
    .map((e: unknown) => String(e).trim().toLowerCase()).filter((e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  try {
    if (body?.kind === "welcome") {
      const name = String(body?.batch ?? `Batch ${istDate(0)}`);
      const { data: g, error } = await supabase
        .from("subscriber_groups").select("id,name,received_on").eq("is_daily_batch", true).ilike("name", name).maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!g) return json({ error: `No daily batch named "${name}"` }, 404);
      const result = await sendWelcomeReport(supabase, g, dryRun, toOverride);
      if (!dryRun && !toOverride.length) await supabase.from("subscriber_groups").update({ welcome_report_sent_at: new Date().toISOString() }).eq("id", g.id);
      return json(result);
    }
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.date ?? "")) ? String(body.date) : istDate(0);
    return json(await sendDailyReport(supabase, day, dryRun, toOverride));
  } catch (e) {
    console.error(JSON.stringify({ tag: "stats-report", error: String(e).slice(0, 300) }));
    return json({ error: String(e) }, 500);
  }
});
