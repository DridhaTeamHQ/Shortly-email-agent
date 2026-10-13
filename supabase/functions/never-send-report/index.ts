// never-send-report: the day's never-send additions as an Excel file.
//
// One row per address added to the never-send list (email_suppressions) on the
// IST day, with its status and a plain-English "why", plus a summary sheet.
// The daily stats email (stats-report) attaches the same file; this function
// is for a never-send list on its own.
//
//   POST {}                       -> email today's (IST) additions to REPORT_EMAIL_TO
//   POST {"date":"2026-10-13"}    -> that IST day
//   POST {"dry_run":true}         -> counts only; nothing is sent
//   POST {"download":true}        -> the Excel file itself; nothing is sent

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { neverSendReason, neverSendStatus } from "../_shared/never-send-status.ts";
import { fetchNeverSend, istDate, neverSendWorkbook, reportRecipients, sendReportEmail } from "../_shared/report-mail.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const denied = await requireAgent(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.date ?? "")) ? String(body.date) : istDate(0);
  const start = new Date(`${day}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 86400000);
  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  try {
    const rows = await fetchNeverSend(supabase, start.toISOString(), end.toISOString());
    const all = await fetchNeverSend(supabase);
    const byStatus: Record<string, number> = {};
    for (const r of rows) {
      const status = neverSendStatus(neverSendReason(r));
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
    const override = (Array.isArray(body?.to) ? body.to : body?.to ? [body.to] : [])
      .map((e: unknown) => String(e).trim().toLowerCase()).filter((e: string) => e.includes("@"));
    const to = override.length ? override : reportRecipients();
    if (body?.dry_run === true) return json({ dry_run: true, day, new_today: rows.length, by_status: byStatus, total: all.length, to });

    const file = neverSendWorkbook(day, rows, all);
    if (body?.download === true) {
      return new Response(file, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="never-send-${day}.xlsx"`,
        },
      });
    }
    if (to.length === 0) return json({ error: "REPORT_EMAIL_TO is not set" }, 400);

    const lines = Object.entries(byStatus).map(([s, n]) => `<li>${s}: <b>${n}</b></li>`).join("");
    const html = `<p>Never-send list for <b>${day}</b> (IST): <b>${rows.length}</b> new address${rows.length === 1 ? "" : "es"}.</p>` +
      (lines ? `<ul>${lines}</ul>` : "") +
      `<p>All-time total on the never-send list: <b>${all.length}</b>. Details and the reason for each address are in the attached Excel file.</p>`;
    const messageId = await sendReportEmail({
      to, subject: `dailymattr never-send list - ${day} (${rows.length} new)`, html,
      attachment: { name: `never-send-${day}.xlsx`, data: file },
    });
    return json({ ok: true, day, new_today: rows.length, by_status: byStatus, total: all.length, to, messageId });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
