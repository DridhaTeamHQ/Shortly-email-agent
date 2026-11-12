// work-report: the daily technical work report to the owner (2026-11-12).
// Runs on the server (cron 19:00 IST), so it works with every computer off.
//
//   POST {}                          send today's report (once per day)
//   POST {"day":"2026-11-12"}        that day
//   POST {"dry_run":true}            build only; returns the HTML, sends nothing
//   POST {"force":true}              send again even if already sent
//
// Report notes come from work_report_days.report (written during the day's
// Claude sessions). Live numbers are added from the database every time. If a
// day has no notes, a short "no changes" report with the numbers and the main
// system flow chart is sent. Recipient: the WORK_REPORT_TO secret only (the
// owner) - never subscribers. No secret set = nothing is sent.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import ExcelJS from "npm:exceljs@4.4.0";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { istDate, sendReportEmail } from "../_shared/report-mail.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Step = { t: string; s?: string; kind?: string; label?: string; side?: Step };
type Flow = { title: string; explain?: string; steps: Step[] };

const KIND: Record<string, [string, string, string, string]> = {
  function: ["E1F5EE", "0F6E56", "085041", "Function (server)"],
  database: ["EEEDFE", "534AB7", "3C3489", "Database"],
  owner: ["FAEEDA", "854F0B", "633806", "You"],
  outside: ["F1EFE8", "888780", "444441", "Outside service"],
  blocked: ["FAECE7", "993C1D", "712B13", "Stopped / never mailed"],
  check: ["E6F1FB", "185FA5", "0C447C", "Decision"],
};

// The main system flow, always included.
const SYSTEM_FLOW: Flow = {
  title: "Main system flow: welcome queue to inbox, then the daily newsletter",
  explain: "Everything here runs on the Supabase server, with every computer off.",
  steps: [
    { t: "You add a list", s: "Dashboard Welcome queue, welcome-pool function", kind: "owner" },
    { t: "welcome_pool table", s: "Addresses waiting", kind: "database" },
    { t: "11:50 AM welcome_ramp_tick", s: "Sets today's limit", kind: "database" },
    { t: "release-welcome-pool", s: "12:00 to 3:00 PM, 120 every 10 min", kind: "function" },
    { t: "subscribers (import-batch)", s: "Gmail only, never-send list, SES check", kind: "function", side: { t: "Blocked", s: "Never-send list", kind: "blocked", label: "fails" } },
    { t: "send-welcomes", s: "40 every 5 minutes", kind: "function" },
    { t: "Amazon SES", s: "Delivers to the inbox", kind: "outside" },
    { t: "email-events", s: "Saves delivery and bounces", kind: "function", side: { t: "Hard bounce", s: "Never-send list", kind: "blocked", label: "bounce" } },
    { t: "send-newsletter", s: "Next day 9:02 AM, 60 per minute", kind: "function" },
    { t: "7:00 PM work-report", s: "This email", kind: "function" },
  ],
};

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const txt = (s: unknown) => esc(s).replace(/`([^`]+)`/g, '<code style="background:#F1EFE8;padding:1px 4px;border-radius:3px;font-size:13px">$1</code>');
const plain = (s: unknown) => String(s ?? "").replace(/`([^`]+)`/g, "$1");

function box(b: Step) {
  const [bg, border, ink] = KIND[b.kind ?? "outside"] ?? KIND.outside;
  return `<td style="background:#${bg};border:1px solid #${border};border-radius:8px;padding:8px 14px;text-align:center;color:#${ink};font-size:14px;min-width:220px"><b>${txt(b.t)}</b>${b.s ? `<br><span style="font-size:12px">${txt(b.s)}</span>` : ""}</td>`;
}
function flowHtml(f: Flow) {
  const rows = f.steps.map((st, i) => {
    const side = st.side ? `<td style="color:#888780;font-size:12px;padding:0 8px;white-space:nowrap">${esc(st.side.label ?? "")} &rarr;</td>${box(st.side)}` : "<td></td><td></td>";
    const arrow = i < f.steps.length - 1
      ? `<tr><td style="text-align:center;color:#888780;font-size:18px;line-height:20px;padding:2px 0">&darr;${st.label ? `<br><span style="font-size:11px">${esc(st.label)}</span>` : ""}</td><td></td><td></td></tr>`
      : "";
    return `<tr>${box(st)}${side}</tr>${arrow}`;
  }).join("");
  const kinds = [...new Set(f.steps.flatMap((s) => [s.kind, s.side?.kind]).filter(Boolean))] as string[];
  const legend = kinds.map((k) => `<span style="display:inline-block;width:10px;height:10px;background:#${KIND[k][0]};border:1px solid #${KIND[k][1]};border-radius:2px;margin:0 4px 0 12px"></span>${KIND[k][3]}`).join("");
  return `<h3 style="font-size:16px;margin:24px 0 6px">${txt(f.title)}</h3>${f.explain ? `<p style="margin:0 0 10px;color:#444441">${txt(f.explain)}</p>` : ""}<table cellpadding="0" cellspacing="0">${rows}</table><p style="font-size:12px;color:#5F5E5A;margin:8px 0 0">${legend}</p>`;
}
const list = (items?: string[]) => items?.length
  ? `<ul style="margin:6px 0 12px;padding-left:20px">${items.map((i) => `<li style="margin:3px 0">${txt(i)}</li>`).join("")}</ul>`
  : `<p style="color:#888780;margin:6px 0 12px">No changes.</p>`;
const h2 = (s: string) => `<h2 style="font-size:18px;border-bottom:2px solid #3979FF;padding-bottom:4px;margin:32px 0 10px">${esc(s)}</h2>`;
const table = (head: string[], rows: string[][]) => `<table cellpadding="6" style="border-collapse:collapse;font-size:14px;margin:6px 0 12px"><tr>${head.map((h) => `<th style="text-align:left;border-bottom:1px solid #B4B2A9;padding:6px 10px">${esc(h)}</th>`).join("")}</tr>${rows.map((row) => `<tr>${row.map((c) => `<td style="border-bottom:1px solid #EEE;padding:6px 10px;vertical-align:top">${txt(c)}</td>`).join("")}</tr>`).join("")}</table>`;

function buildHtml(r: Any) {
  const c = r.changes ?? {};
  return `<!doctype html><html><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#2C2C2A;line-height:1.55;max-width:760px">
<p style="font-size:22px;margin:0"><b style="color:#3979FF">dailymattr</b> work report</p>
<p style="margin:2px 0 16px;color:#5F5E5A">${esc(r.date)}${r.title ? ` &middot; ${esc(r.title)}` : ""}</p>
${h2("Summary")}${list(r.summary)}
${r.numbers?.length ? table(["Item", "Number"], r.numbers) : ""}
${h2("Time sheet")}${r.timesheet?.length ? table(["Task", "What was done"], r.timesheet.map((t: Any) => [t.task, t.detail])) : `<p style="color:#888780">No work logged today.</p>`}
${h2("Changes, by place")}
<h3 style="font-size:16px;margin:12px 0 4px">Database (tables, columns, SQL functions, triggers, cron jobs, migrations)</h3>${list(c.database)}
<h3 style="font-size:16px;margin:12px 0 4px">Backend (edge functions: new and changed)</h3>${list(c.backend)}
<h3 style="font-size:16px;margin:12px 0 4px">Dashboard</h3>${list(c.dashboard)}
<h3 style="font-size:16px;margin:12px 0 4px">Settings and secrets</h3>${list(c.settings)}
<h3 style="font-size:16px;margin:12px 0 4px">Code files and folders</h3>${list(c.files)}
<h3 style="font-size:16px;margin:12px 0 4px">GitHub commits</h3>${list(c.commits)}
${h2("Workflows and flow charts")}${(r.flows ?? []).map(flowHtml).join("")}
${r.issues?.length ? h2("Problems found and how they were fixed") + table(["Problem", "Why it happened", "Fix"], r.issues.map((i: Any) => [i.problem, i.cause, i.fix])) : ""}
${r.explanations?.length ? h2("Explanations (questions asked today)") + r.explanations.map((e: Any) => `<p style="margin:14px 0 4px"><b>${txt(e.q)}</b></p><p style="margin:0 0 6px">${txt(e.a)}</p>`).join("") : ""}
${h2("Next / pending")}${list(r.next)}
<p style="margin-top:32px;font-size:12px;color:#888780">Sent by the server every day at 7:00 PM IST (work-report function). Internal report, only to the owner.</p>
</body></html>`;
}

async function buildXlsx(r: Any): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const BLUE = "FF3979FF";
  const wrap = { wrapText: true, vertical: "top" } as const;
  const center = { wrapText: true, horizontal: "center", vertical: "middle" } as const;
  const head = (ws: Any, row: number, values: string[]) => {
    values.forEach((v, i) => {
      const cell = ws.getCell(row, i + 1);
      cell.value = v;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
    });
  };
  const title = (ws: Any, t: string) => {
    ws.getCell("A1").value = t;
    ws.getCell("A1").font = { bold: true, size: 14, color: { argb: BLUE } };
    ws.getCell("A2").value = r.date ?? "";
  };

  let ws = wb.addWorksheet("Summary");
  title(ws, `dailymattr work report - ${r.title ?? ""}`);
  ws.getColumn(1).width = 4; ws.getColumn(2).width = 90; ws.getColumn(3).width = 40;
  let row = 4;
  for (const s of r.summary ?? []) { ws.getCell(row, 1).value = "•"; ws.getCell(row, 2).value = plain(s); ws.getCell(row, 2).alignment = wrap; ws.getRow(row).height = 45; row++; }
  row++;
  if (r.numbers?.length) {
    head(ws, row, ["", "Item", "Number"]); row++;
    for (const [k, v] of r.numbers) { ws.getCell(row, 2).value = plain(k); ws.getCell(row, 3).value = plain(v); row++; }
  }

  ws = wb.addWorksheet("Time sheet");
  title(ws, "Time sheet");
  ws.getColumn(1).width = 34; ws.getColumn(2).width = 90;
  head(ws, 4, ["Task", "What was done"]);
  (r.timesheet ?? []).forEach((t: Any, i: number) => {
    ws.getCell(5 + i, 1).value = plain(t.task); ws.getCell(5 + i, 1).alignment = wrap;
    ws.getCell(5 + i, 2).value = plain(t.detail); ws.getCell(5 + i, 2).alignment = wrap;
    ws.getRow(5 + i).height = 35;
  });

  ws = wb.addWorksheet("Changes");
  title(ws, "Changes, by place");
  ws.getColumn(1).width = 24; ws.getColumn(2).width = 120;
  head(ws, 4, ["Place", "Change"]);
  row = 5;
  for (const [key, label] of [["database", "Database"], ["backend", "Backend (edge functions)"], ["dashboard", "Dashboard"], ["settings", "Settings and secrets"], ["files", "Code files and folders"], ["commits", "GitHub commits"]]) {
    for (const item of (r.changes?.[key]?.length ? r.changes[key] : ["No changes."])) {
      ws.getCell(row, 1).value = label; ws.getCell(row, 1).font = { bold: true };
      ws.getCell(row, 2).value = plain(item); ws.getCell(row, 2).alignment = wrap; ws.getRow(row).height = 32; row++;
    }
  }

  ws = wb.addWorksheet("Flow charts");
  title(ws, "Workflows and flow charts");
  [3, 16, 16, 16, 12, 14, 14, 14].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  const drawBox = (rr: number, c1: number, c2: number, st: Step) => {
    const [bg, border, ink] = KIND[st.kind ?? "outside"] ?? KIND.outside;
    ws.mergeCells(rr, c1, rr, c2);
    const cell = ws.getCell(rr, c1);
    cell.value = plain(st.t) + (st.s ? `\n${plain(st.s)}` : "");
    cell.alignment = center;
    cell.font = { bold: true, color: { argb: `FF${ink}` } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${bg}` } };
    const side = { style: "thin", color: { argb: `FF${border}` } };
    cell.border = { top: side, bottom: side, left: side, right: side };
    ws.getRow(rr).height = 38;
  };
  row = 4;
  for (const f of r.flows ?? []) {
    ws.getCell(row, 2).value = plain(f.title); ws.getCell(row, 2).font = { bold: true, size: 12 }; row++;
    if (f.explain) { ws.mergeCells(row, 2, row, 8); ws.getCell(row, 2).value = plain(f.explain); ws.getCell(row, 2).alignment = wrap; ws.getRow(row).height = 48; row++; }
    f.steps.forEach((st: Step, i: number) => {
      drawBox(row, 2, 4, st);
      if (st.side) { ws.getCell(row, 5).value = `${st.side.label ?? ""} →`; ws.getCell(row, 5).alignment = center; drawBox(row, 6, 8, st.side); }
      row++;
      if (i < f.steps.length - 1) { ws.mergeCells(row, 2, row, 4); ws.getCell(row, 2).value = `↓${st.label ? `  ${st.label}` : ""}`; ws.getCell(row, 2).alignment = center; row++; }
    });
    row += 3;
  }

  if (r.issues?.length) {
    ws = wb.addWorksheet("Problems");
    title(ws, "Problems found and how they were fixed");
    [45, 60, 60].forEach((w, i) => (ws.getColumn(i + 1).width = w));
    head(ws, 4, ["Problem", "Why it happened", "Fix"]);
    r.issues.forEach((it: Any, i: number) => {
      ["problem", "cause", "fix"].forEach((k, j) => { ws.getCell(5 + i, j + 1).value = plain(it[k]); ws.getCell(5 + i, j + 1).alignment = wrap; });
      ws.getRow(5 + i).height = 60;
    });
  }
  if (r.explanations?.length) {
    ws = wb.addWorksheet("Explanations");
    title(ws, "Explanations (questions asked today)");
    ws.getColumn(1).width = 45; ws.getColumn(2).width = 110;
    head(ws, 4, ["Question", "Answer"]);
    r.explanations.forEach((e: Any, i: number) => {
      ws.getCell(5 + i, 1).value = plain(e.q); ws.getCell(5 + i, 1).alignment = wrap;
      ws.getCell(5 + i, 2).value = plain(e.a); ws.getCell(5 + i, 2).alignment = wrap;
      ws.getRow(5 + i).height = 60;
    });
  }
  ws = wb.addWorksheet("Next");
  title(ws, "Next / pending");
  ws.getColumn(2).width = 120;
  (r.next ?? []).forEach((n: string, i: number) => { ws.getCell(4 + i, 1).value = "•"; ws.getCell(4 + i, 2).value = plain(n); ws.getCell(4 + i, 2).alignment = wrap; });

  return new Uint8Array(await wb.xlsx.writeBuffer());
}

// Live numbers for the day, read from the database.
// deno-lint-ignore no-explicit-any
async function liveNumbers(supabase: any, day: string): Promise<string[][]> {
  const start = new Date(`${day}T00:00:00+05:30`).toISOString();
  const end = new Date(new Date(start).getTime() + 86400000).toISOString();
  const nlStart = new Date(`${day}T09:00:00+05:30`).toISOString(), nlEnd = new Date(`${day}T11:45:00+05:30`).toISOString();
  const count = async (q: Any) => (await q).count ?? 0;
  const ev = (type: string, from: string, to: string) =>
    supabase.from("email_events").select("id", { count: "exact", head: true }).eq("event_type", type).gte("received_at", from).lt("received_at", to);
  const [newsletter, delivered, bounces, complaints, waiting] = await Promise.all([
    count(ev("delivery", nlStart, nlEnd)),
    count(ev("delivery", start, end)),
    count(supabase.from("email_events").select("id", { count: "exact", head: true }).eq("event_type", "bounce").eq("bounce_type", "Permanent").gte("received_at", start).lt("received_at", end)),
    count(ev("complaint", start, end)),
    count(supabase.from("welcome_pool").select("email", { count: "exact", head: true }).is("released_on", null)),
  ]);
  const { data: batch } = await supabase.from("subscriber_groups").select("added_count").eq("is_daily_batch", true).eq("received_on", day).maybeSingle();
  const { data: st } = await supabase.from("welcome_pool_settings").select("daily_limit,ramp_ceiling,ramp_note").eq("id", true).maybeSingle();
  const fmt = (n: number) => Number(n).toLocaleString("en-IN");
  return [
    ["Newsletter delivered (9:00 to 11:45 AM)", fmt(newsletter)],
    ["All mails delivered today", fmt(delivered)],
    ["New welcome addresses added today", fmt(batch?.added_count ?? 0)],
    ["Hard bounces today (incl. SES blocked)", fmt(bounces)],
    ["Spam complaints today (SES; Gmail spam is only in Postmaster)", fmt(complaints)],
    ["Welcome queue waiting", fmt(waiting)],
    ["Welcome limit per day / safety cap", `${st?.daily_limit ?? "?"} / ${st?.ramp_ceiling ?? "?"}`],
    ["Last ramp decision", st?.ramp_note ?? "-"],
  ];
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const denied = await requireAgent(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  const day: string = /^\d{4}-\d{2}-\d{2}$/.test(body?.day ?? "") ? body.day : istDate(0);
  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  try {
    const { data: row } = await supabase.from("work_report_days").select("report,sent_at").eq("day", day).maybeSingle();
    if (row?.sent_at && !body?.force && !body?.dry_run) return json({ day, skipped: "already sent", sent_at: row.sent_at });

    const r: Any = { ...(row?.report ?? {}) };
    const nice = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    r.date = r.date ?? nice;
    if (!row?.report || !Object.keys(row.report).length) {
      r.title = "No work logged today";
      r.summary = ["No changes were made today. The system ran on its own; today's numbers are below."];
    }
    r.numbers = [...(r.numbers ?? []), ...(await liveNumbers(supabase, day)).map(([k, v]) => [`Live: ${k}`, v])];
    r.flows = [...(r.flows ?? []), SYSTEM_FLOW];

    const html = buildHtml(r);
    if (body?.dry_run) return json({ day, dry_run: true, html });

    let attachment: { name: string; data: Uint8Array } | undefined;
    try {
      attachment = { name: `dailymattr-work-report-${day}.xlsx`, data: await buildXlsx(r) };
    } catch (e) {
      console.error(JSON.stringify({ tag: "work-report", xlsx_error: String(e).slice(0, 300) }));
    }
    const to = (Deno.env.get("WORK_REPORT_TO") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!to.length) throw new Error("WORK_REPORT_TO secret is not set - report not sent");
    const subject = `dailymattr work report - ${new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`;
    const messageId = await sendReportEmail({ to, subject, html, attachment });
    await supabase.from("work_report_days").upsert({ day, report: row?.report ?? {}, sent_at: new Date().toISOString(), message_id: messageId });
    console.log(JSON.stringify({ tag: "work-report", day, to, messageId, xlsx: Boolean(attachment) }));
    return json({ day, sent: true, to, message_id: messageId, xlsx: Boolean(attachment) });
  } catch (e) {
    console.error(JSON.stringify({ tag: "work-report", error: String(e).slice(0, 300) }));
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
