// Internal report emails (stats, never-send list) to the team, with an
// optional Excel attachment. Sent through SES as a raw MIME message and WITHOUT
// the configuration set, so these never mix into subscriber delivery and
// bounce statistics.
import * as XLSX from "npm:xlsx@0.18.5";
import { SendEmailCommand, SESv2Client } from "npm:@aws-sdk/client-sesv2";
import { requiredEnv } from "./http.ts";
import { neverSendReason, neverSendStatus, neverSendWhy } from "./never-send-status.ts";

export type NeverSendRow = { email: string; reason: string; detail: string | null; source: string | null; created_at: string };

/** Report recipients: REPORT_EMAIL_TO (comma-separated); NEVER_SEND_REPORT_TO is the older name. */
export function reportRecipients(): string[] {
  return (Deno.env.get("REPORT_EMAIL_TO") ?? Deno.env.get("NEVER_SEND_REPORT_TO") ?? "")
    .split(",").map((e) => e.trim()).filter(Boolean);
}

export function istDate(offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" })
    .format(new Date(Date.now() + offsetDays * 86400000));
}

export function istTime(iso: string | Date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

// deno-lint-ignore no-explicit-any
export async function fetchNeverSend(supabase: any, from?: string, to?: string): Promise<NeverSendRow[]> {
  const rows: NeverSendRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    let q = supabase.from("email_suppressions").select("email,reason,detail,source,created_at")
      .order("created_at", { ascending: false }).range(offset, offset + 999);
    if (from) q = q.gte("created_at", from);
    if (to) q = q.lt("created_at", to);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) return rows;
  }
}

/** Excel: a summary sheet (new today vs all time, per status) and one row per address. */
export function neverSendWorkbook(day: string, rows: NeverSendRow[], all: NeverSendRow[]) {
  const count = (list: NeverSendRow[]) => {
    const m = new Map<string, number>();
    for (const r of list) m.set(neverSendReason(r), (m.get(neverSendReason(r)) ?? 0) + 1);
    return m;
  };
  const today = count(rows);
  const total = count(all);
  const summary: (string | number)[][] = [
    ["Never-send list report", `${day} (IST)`],
    ["New addresses today", rows.length],
    ["All-time total", all.length],
    [],
    ["Status", "New today", "All time", "Why"],
    ...[...new Set([...today.keys(), ...total.keys()])]
      .sort((a, b) => (total.get(b) ?? 0) - (total.get(a) ?? 0))
      .map((reason) => [neverSendStatus(reason), today.get(reason) ?? 0, total.get(reason) ?? 0, neverSendWhy(reason)]),
  ];
  const detail = rows.map((r) => {
    const reason = neverSendReason(r);
    return {
      Email: r.email,
      Status: neverSendStatus(reason),
      "Why it is on the never-send list": neverSendWhy(reason),
      Detail: r.detail ?? "",
      "Added (IST)": istTime(r.created_at),
      Source: r.source ?? "",
    };
  });
  const book = XLSX.utils.book_new();
  const s1 = XLSX.utils.aoa_to_sheet(summary);
  s1["!cols"] = [{ wch: 44 }, { wch: 12 }, { wch: 12 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(book, s1, "Summary");
  const s2 = XLSX.utils.json_to_sheet(detail.length ? detail : [{ Email: "No new never-send addresses today" }]);
  s2["!cols"] = [{ wch: 36 }, { wch: 40 }, { wch: 70 }, { wch: 50 }, { wch: 18 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(book, s2, "Never-send");
  return new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }));
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/.{76}/g, "$&\r\n");
}

let client: SESv2Client | null = null;

export async function sendReportEmail(opts: {
  to: string[];
  subject: string;
  html: string;
  attachment?: { name: string; data: Uint8Array };
}) {
  const from = Deno.env.get("FROM_EMAIL") ?? "Dailywrap <team@dailymattr.com>";
  const boundary = `rpt-${crypto.randomUUID()}`;
  const parts = [
    `From: ${from}`,
    `To: ${opts.to.join(", ")}`,
    `Subject: ${opts.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    opts.html,
    "",
  ];
  if (opts.attachment) {
    parts.push(
      `--${boundary}`,
      `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="${opts.attachment.name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${opts.attachment.name}"`,
      "",
      base64(opts.attachment.data),
    );
  }
  parts.push(`--${boundary}--`, "");
  client ??= new SESv2Client({
    region: requiredEnv("AWS_REGION"),
    credentials: { accessKeyId: requiredEnv("AWS_ACCESS_KEY_ID"), secretAccessKey: requiredEnv("AWS_SECRET_ACCESS_KEY") },
  });
  const res = await client.send(new SendEmailCommand({
    Content: { Raw: { Data: new TextEncoder().encode(parts.join("\r\n")) } },
  }));
  return res.MessageId ?? null;
}
