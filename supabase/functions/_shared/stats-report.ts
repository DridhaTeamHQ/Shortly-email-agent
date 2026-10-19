// Stats report emails for the team. Two separate reports, labelled so they
// can't be confused in the inbox:
//
//   daily    NEWSLETTER REPORT, 11:35 IST by cron, after the newsletter window
//            (09:02-11:29) has closed: newsletter results only, sending health,
//            list size, never-send additions -- with the day's never-send list
//            attached as Excel.
//   welcome  WELCOME MAIL REPORT, once per daily batch, after all its welcome
//            mails are sent and SES has had time to report on them.
//
// All numbers come from email_report_stats() in one call.
import { fetchNeverSend, istDate, istTime, neverSendWorkbook, reportRecipients, sendReportEmail } from "./report-mail.ts";
import { neverSendReason, neverSendStatus, neverSendWhy } from "./never-send-status.ts";
import { fetchAllRows } from "./page.ts";

// deno-lint-ignore no-explicit-any
type Client = any;
// deno-lint-ignore no-explicit-any
type Stats = Record<string, any>;

const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-IN");
const pct = (part: unknown, whole: unknown) => {
  const w = Number(whole ?? 0);
  return w ? ` (${(100 * Number(part ?? 0) / w).toFixed(1)}%)` : "";
};

function table(title: string, rows: Array<[string, string]>) {
  const body = rows.map(([label, value]) =>
    `<tr><td style="padding:6px 12px;border:1px solid #e3e3e3">${label}</td>` +
    `<td style="padding:6px 12px;border:1px solid #e3e3e3;text-align:right;font-weight:600">${value}</td></tr>`
  ).join("");
  return `<h3 style="margin:22px 0 8px;font:700 15px Arial,sans-serif;color:#111">${title}</h3>` +
    `<table style="border-collapse:collapse;font:14px Arial,sans-serif;color:#222;min-width:420px">${body}</table>`;
}

// ---- Opens (SES open tracking, live since 2026-10-19) ----------------------
// An open is counted once per mail (a reader opening twice counts once).
// Approximate: mails in the spam folder or read with images off never report.
const WELCOME_SUBJECT_LIKE = "%part of the club%";
/** Newsletter subjects start with the send date, e.g. "Oct 19 - Your dailymattr Wrap is here!". */
const newsletterSubjectLike = (day: string) =>
  `${new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} - %dailymattr%`;
const SUBJECT = "raw->mail->commonHeaders->>subject";

async function deliveredCount(supabase: Client, subjectLike: string, since: string) {
  const { count, error } = await supabase.from("email_events").select("id", { count: "exact", head: true })
    .eq("event_type", "delivery").gte("received_at", since).ilike(SUBJECT, subjectLike);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function openRows(supabase: Client, subjectLike: string, since: string) {
  const { data, error } = await fetchAllRows<{ message_id: string; email: string }>((from, to) =>
    supabase.from("email_events").select("message_id,email")
      .eq("event_type", "open").gte("received_at", since).ilike(SUBJECT, subjectLike)
      .order("id").range(from, to));
  if (error) throw new Error(error.message);
  return data;
}

const istStart = (day: string) => new Date(`${day}T00:00:00+05:30`).toISOString();
const addDays = (day: string, d: number) =>
  new Date(new Date(`${day}T00:00:00Z`).getTime() + d * 86400000).toISOString().slice(0, 10);

type OpensRow = { day: string; delivered: number; opened: number };

/** Newsletter opens for `day` and the 6 days before it, newest first. */
async function newsletterOpens(supabase: Client, day: string) {
  const out: OpensRow[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(day, -i);
    const like = newsletterSubjectLike(d);
    const delivered = await deliveredCount(supabase, like, istStart(d));
    const opened = new Set((await openRows(supabase, like, istStart(d))).map((r) => r.message_id)).size;
    out.push({ day: d, delivered, opened });
  }
  return out;
}

function opensTable(title: string, rows: OpensRow[]) {
  const cell = "padding:6px 12px;border:1px solid #e3e3e3";
  const head = ["Newsletter of", "Delivered", "Opened", "Open rate"]
    .map((h) => `<th style="${cell};background:#f5f5f5;text-align:left">${h}</th>`).join("");
  const body = rows.map((r) => `<tr><td style="${cell}">${r.day}</td>` +
    `<td style="${cell};text-align:right">${n(r.delivered)}</td>` +
    `<td style="${cell};text-align:right;font-weight:600">${n(r.opened)}</td>` +
    `<td style="${cell};text-align:right;font-weight:600">${r.delivered ? (100 * r.opened / r.delivered).toFixed(1) + "%" : "-"}</td></tr>`).join("");
  return `<h3 style="margin:22px 0 8px;font:700 15px Arial,sans-serif;color:#111">${title}</h3>` +
    `<table style="border-collapse:collapse;font:14px Arial,sans-serif;color:#222;min-width:420px"><tr>${head}</tr>${body}</table>` +
    `<p style="margin:6px 0 0;color:#666">Readers keep opening for days, so older rows are more complete than today's. Open tracking started 19 Oct ~1 PM IST; earlier opens were not recorded.</p>`;
}

/** Welcome opens: this batch (by member address) and all welcomes of the last 7 days. */
async function welcomeOpens(supabase: Client, batchId: string, receivedOn: string) {
  const { data: members, error } = await fetchAllRows<{ subscribers: { email: string } }>((from, to) =>
    supabase.from("subscriber_group_members").select("subscriber_id, subscribers!inner(email)")
      .eq("group_id", batchId).order("subscriber_id").range(from, to));
  if (error) throw new Error(error.message);
  const emails = new Set(members.map((m) => m.subscribers.email.toLowerCase()));
  const batchOpened = new Set((await openRows(supabase, WELCOME_SUBJECT_LIKE, istStart(receivedOn)))
    .map((r) => r.email?.toLowerCase()).filter((e) => e && emails.has(e))).size;
  const since = istStart(addDays(istDate(0), -6));
  const weekDelivered = await deliveredCount(supabase, WELCOME_SUBJECT_LIKE, since);
  const weekOpened = new Set((await openRows(supabase, WELCOME_SUBJECT_LIKE, since)).map((r) => r.message_id)).size;
  return { batchOpened, weekDelivered, weekOpened };
}

/** Open stats stay out of the reports until the owner asks for them:
 *  REPORT_SHOW_OPENS=1 turns them on for every report (cron included); a
 *  manual stats-report call can also pass "opens": true. */
const showOpens = (override?: boolean) => override ?? Deno.env.get("REPORT_SHOW_OPENS") === "1";

function welcomeTable(w: Stats, o: { batchOpened: number } | null) {
  return table("Welcome mails", [
    ["Welcome mails sent", n(w.welcome_sent)],
    ["Delivered", n(w.delivered) + pct(w.delivered, w.welcome_sent)],
    ...(o ? [["Opened so far", n(o.batchOpened) + pct(o.batchOpened, w.delivered)] as [string, string]] : []),
    ["Blocked by SES (below HIGH) - never delivered", n(w.blocked_by_ses)],
    ["Hard bounces", n(w.hard_bounces)],
    ["Soft bounces", n(w.soft_bounces)],
    ["Spam complaints", n(w.complaints)],
    ["No report from SES yet", n(w.no_report_yet)],
    ["Still to send", n(w.welcome_pending)],
    ["Active subscribers from these batches", n(w.active_now)],
  ]);
}

function batchTable(batches: Stats[]) {
  if (!batches?.length) return "";
  const b = batches.reduce((acc, x) => {
    for (const k of ["rows_in_file", "added", "duplicates", "rejected", "already_known", "suppressed"]) acc[k] = (acc[k] ?? 0) + Number(x[k] ?? 0);
    return acc;
  }, {} as Record<string, number>);
  return table(`Upload: ${batches.map((x) => x.name).join(", ")}`, [
    ["Rows in the files", n(b.rows_in_file)],
    ["Passed pre-validation and added", n(b.added)],
    ["Rejected by pre-validation (to never-send)", n(b.rejected)],
    ["Already on the list (left alone)", n(b.already_known)],
    ["Repeated entries skipped", n(b.duplicates)],
  ]);
}

/** Never-send list by status: new today and all time, with the reason. */
function neverSendTable(today: Array<{ reason: string; detail: string | null }>, all: Array<{ reason: string; detail: string | null }>) {
  const count = (list: typeof all) => {
    const m = new Map<string, number>();
    for (const r of list) m.set(neverSendReason(r), (m.get(neverSendReason(r)) ?? 0) + 1);
    return m;
  };
  const t = count(today), a = count(all);
  const cell = "padding:6px 12px;border:1px solid #e3e3e3";
  const head = ["Status", "New today", "All time", "Why"]
    .map((h) => `<th style="${cell};background:#f5f5f5;text-align:left">${h}</th>`).join("");
  const body = [...new Set([...t.keys(), ...a.keys()])]
    .sort((x, y) => (a.get(y) ?? 0) - (a.get(x) ?? 0))
    .map((reason) => `<tr><td style="${cell}">${neverSendStatus(reason)}</td>` +
      `<td style="${cell};text-align:right;font-weight:600">${n(t.get(reason) ?? 0)}</td>` +
      `<td style="${cell};text-align:right;font-weight:600">${n(a.get(reason) ?? 0)}</td>` +
      `<td style="${cell};color:#555">${neverSendWhy(reason)}</td></tr>`).join("");
  const total = `<tr><td style="${cell};font-weight:700">Total</td><td style="${cell};text-align:right;font-weight:700">${n(today.length)}</td>` +
    `<td style="${cell};text-align:right;font-weight:700">${n(all.length)}</td><td style="${cell}"></td></tr>`;
  return `<h3 style="margin:22px 0 8px;font:700 15px Arial,sans-serif;color:#111">Never-send list by status: ${n(all.length)} addresses in total, ${n(today.length)} added today</h3>` +
    `<table style="border-collapse:collapse;font:14px Arial,sans-serif;color:#222;min-width:420px"><tr>${head}</tr>${body}${total}</table>`;
}

function healthAndList(s: Stats) {
  const h = s.health, l = s.list;
  return table("Sending health (last 7 days)", [
    ["Delivered", n(h.delivered_7d)],
    ["Hard-bounce rate (brake at 2%)", `${h.hard_bounce_rate_pct ?? 0}%`],
    ["Spam-complaint rate (brake at 0.08%)", `${h.complaint_rate_pct ?? 0}%`],
    ["Blocked by SES validation", n(h.blocked_by_ses_7d)],
    ["Unsubscribed today", n(h.unsubscribed_today)],
  ]) + table("Subscriber list", [
    ["Active subscribers", n(l.subscribed)],
    ["Non-gmail subscribers (only addresses you allowed)", n(l.non_gmail_subscribed)],
    ["Eligible for the next newsletter", n(l.eligible_next_newsletter)],
  ]);
}

const KINDS = {
  newsletter: { label: "NEWSLETTER REPORT", color: "#3979FF" },
  welcome: { label: "WELCOME MAIL REPORT", color: "#1E8E3E" },
};

function wrap(kind: keyof typeof KINDS, heading: string, about: string, generatedAt: string, inner: string) {
  const k = KINDS[kind];
  return `<div style="font:14px Arial,sans-serif;color:#222">` +
    `<p style="margin:0 0 10px"><span style="display:inline-block;padding:4px 10px;border-radius:4px;background:${k.color};color:#fff;font:700 12px Arial,sans-serif;letter-spacing:.5px">${k.label}</span></p>` +
    `<h2 style="margin:0 0 4px;font:700 18px Arial,sans-serif;color:#111">${heading}</h2>` +
    `<p style="margin:0 0 6px;color:#333">${about}</p>` +
    `<p style="margin:0 0 6px;color:#666">As of ${istTime(generatedAt)} IST. SES reports keep arriving for a while after sending; numbers can still change slightly.</p>` +
    inner + `</div>`;
}

export async function statsFor(supabase: Client, day: string, batchId: string | null = null): Promise<Stats> {
  const { data, error } = await supabase.rpc("email_report_stats", { p_day: day, p_batch_id: batchId });
  if (error) throw new Error(error.message);
  return data as Stats;
}

export async function sendDailyReport(
  supabase: Client, day = istDate(0), dryRun = false, toOverride?: string[], opensOverride?: boolean,
) {
  const s = await statsFor(supabase, day);
  const nl = s.newsletter;
  const start = new Date(`${day}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 86400000);
  const rows = await fetchNeverSend(supabase, start.toISOString(), end.toISOString());
  const all = await fetchNeverSend(supabase);
  const opens = showOpens(opensOverride) ? await newsletterOpens(supabase, day) : null;
  const html = wrap("newsletter", `Newsletter report - ${day}`,
    "Today's daily newsletter only, sent after the 9 AM send has finished. Welcome mails have their own Welcome mail report.",
    s.generated_at,
    table("Newsletter (9 AM)", [
      ["Queued", n(nl.queued_total)],
      ["Sent", n(nl.sent)],
      ["Delivered", n(nl.delivered) + pct(nl.delivered, nl.sent)],
      ...(opens ? [["Opened so far", n(opens[0].opened) + pct(opens[0].opened, opens[0].delivered)] as [string, string]] : []),
      ["Blocked by SES (below HIGH) - never delivered", n(nl.blocked_by_ses)],
      ["Hard bounces", n(nl.hard_bounces)],
      ["Soft bounces", n(nl.soft_bounces)],
      ["Spam complaints", n(nl.complaints)],
      ["No report from SES yet", n(nl.no_report_yet)],
      ["Not sent (still queued / failed)", n(nl.not_sent)],
      ["Website account emails", n(nl.website_accounts_sent)],
    ]) +
    (opens ? opensTable("Newsletter opens, last 7 days", opens) : "") +
    healthAndList(s) +
    neverSendTable(rows, all) +
    `<p style="margin:14px 0 0">The day's never-send addresses, each with its status and reason, are in the attached Excel file.</p>`);
  const subject = `[Newsletter report] dailymattr ${day}: ${n(nl.sent)} sent, ${n(nl.delivered)} delivered, ${opens ? `${n(opens[0].opened)} opened, ` : ""}${n(nl.hard_bounces)} hard bounces`;
  const to = toOverride?.length ? toOverride : reportRecipients();
  if (dryRun) return { dry_run: true, subject, to, stats: s, html };
  if (!to.length) throw new Error("REPORT_EMAIL_TO is not set");
  const messageId = await sendReportEmail({
    to, subject, html, attachment: { name: `never-send-${day}.xlsx`, data: neverSendWorkbook(day, rows, all) },
  });
  return { ok: true, kind: "daily", day, to, subject, messageId };
}

export async function sendWelcomeReport(
  supabase: Client, batch: { id: string; name: string; received_on: string }, dryRun = false, toOverride?: string[],
  opensOverride?: boolean,
) {
  const s = await statsFor(supabase, batch.received_on, batch.id);
  const w = s.welcome;
  const o = showOpens(opensOverride) ? await welcomeOpens(supabase, batch.id, batch.received_on) : null;
  const html = wrap("welcome", `Welcome mail report - ${batch.name}`,
    "Welcome mails for this upload only, sent once all of them have gone out. The daily newsletter has its own Newsletter report.",
    s.generated_at,
    batchTable(w.batches) + welcomeTable(w, o) +
    (o
      ? table("Welcome mails, last 7 days (all uploads)", [
        ["Delivered", n(o.weekDelivered)],
        ["Opened", n(o.weekOpened) + pct(o.weekOpened, o.weekDelivered)],
      ]) +
        `<p style="margin:6px 0 0;color:#666">This report goes out ~10 minutes after the last welcome, so "Opened so far" is early; the 7-day row shows how welcomes do once readers have had time.</p>`
      : "") +
    healthAndList(s) +
    `<p style="margin:14px 0 0">Everyone who received the welcome joins the newsletter from the next morning.</p>`);
  const subject = `[Welcome mail report] dailymattr ${batch.name}: ${n(w.welcome_sent)} sent, ${n(w.delivered)} delivered, ${o ? `${n(o.batchOpened)} opened, ` : ""}${n(w.blocked_by_ses)} blocked, ${n(w.hard_bounces)} hard bounces`;
  const to = toOverride?.length ? toOverride : reportRecipients();
  if (dryRun) return { dry_run: true, subject, to, stats: s, html };
  if (!to.length) throw new Error("REPORT_EMAIL_TO is not set");
  const messageId = await sendReportEmail({ to, subject, html });
  return { ok: true, kind: "welcome", batch: batch.name, to, subject, messageId };
}

// Wait this long after a batch's last welcome before reporting, so SES has
// reported delivered/bounced for it (send-welcomes runs every 10 minutes, so
// the report goes out on the next run).
const WELCOME_REPORT_SETTLE_MS = 10 * 60 * 1000;

/** Send the welcome report for every daily batch whose welcomes are all sent
 *  and that has not been reported yet. Called by send-welcomes after a run. */
export async function reportFinishedBatches(supabase: Client) {
  const { data, error } = await supabase
    .from("daily_batch_status")
    .select("batch_id,name,received_on,welcome_sent,welcome_pending")
    .eq("welcome_pending", 0)
    .gt("welcome_sent", 0)
    .gte("received_on", istDate(-3));
  if (error) throw new Error(error.message);
  const sent: string[] = [];
  for (const b of (data ?? []) as Array<{ batch_id: string; name: string; received_on: string }>) {
    const { data: g } = await supabase.from("subscriber_groups").select("welcome_report_sent_at").eq("id", b.batch_id).maybeSingle();
    if (g?.welcome_report_sent_at) continue;
    const cutoff = new Date(Date.now() - WELCOME_REPORT_SETTLE_MS).toISOString();
    const { data: recent, error: recentError } = await supabase
      .from("subscriber_group_members")
      .select("subscriber_id, subscribers!inner(welcome_sent_at)")
      .eq("group_id", b.batch_id)
      .gt("subscribers.welcome_sent_at", cutoff)
      .limit(1);
    if (recentError) throw new Error(recentError.message);
    if (recent?.length) continue; // last welcomes just went out -- report on the next run
    await sendWelcomeReport(supabase, { id: b.batch_id, name: b.name, received_on: b.received_on });
    await supabase.from("subscriber_groups").update({ welcome_report_sent_at: new Date().toISOString() }).eq("id", b.batch_id);
    sent.push(b.name);
  }
  return sent;
}
