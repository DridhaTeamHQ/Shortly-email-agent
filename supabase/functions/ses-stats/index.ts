// ses-stats: the AWS SES console numbers, for the dashboard's admin-only
// "SES stats" page (owner, 2026-11-06), so nobody has to open the AWS console.
//
//   POST {"days": 7}  (1-14; SES keeps two weeks of send statistics)
//
// Returns:
//   quota       daily usage -- sent in the last 24h, remaining, % used (GetSendQuota)
//   daily       per IST day: sends, bounces, complaints, rejects (GetSendStatistics)
//   hourly      sends per hour: overall (SES) + newsletter / welcome (our records,
//               via send_counts_hourly(); counted row by row until it exists)
//   reputation  account bounce / complaint rate, hourly (CloudWatch Reputation.*)
//   validation  SES Email Validation verdict counts LOW / MEDIUM / HIGH per day
//               (CloudWatch EmailAddressInsights.ConfidenceVerdict.*)
//   suppression the account suppression list, newest first. SES's own
//               ListSuppressedDestinations comes back empty for this account
//               (see ses-diagnose), so it is rebuilt from the SES bounce and
//               complaint events we store -- the same events that put an
//               address on the list; the count matched the console (41) on
//               2026-11-06.
//
// Read-only. Two locks: requireAgent() like every operational function, plus
// the ADMIN_STATS_TOKEN secret in the x-admin-token header, because editors
// share the agent token and this page is for admins only. Unset secret = 503.
// Each section fails on its own, so a missing IAM permission blanks one panel
// instead of the page.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { GetSendQuotaCommand, GetSendStatisticsCommand, SESClient } from "npm:@aws-sdk/client-ses";
import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from "npm:@aws-sdk/client-cloudwatch";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { fetchAllRows } from "../_shared/page.ts";

const IST_MS = 5.5 * 3600 * 1000;
const istDay = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);

function sameText(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function section<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    console.error(JSON.stringify({ tag: "ses-stats", error: String(e).slice(0, 300) }));
    return { error: String((e as { name?: string })?.name ?? e).slice(0, 160) };
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const denied = await requireAgent(request);
  if (denied) return denied;
  const adminToken = Deno.env.get("ADMIN_STATS_TOKEN") ?? "";
  if (!adminToken) return json({ error: "Admin stats are not set up yet (ADMIN_STATS_TOKEN)." }, 503);
  if (!sameText((request.headers.get("x-admin-token") ?? "").trim(), adminToken)) {
    return json({ error: "Wrong admin password." }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const days = Math.min(14, Math.max(1, Number(body?.days) || 7));
  const region = requiredEnv("AWS_REGION");
  const credentials = { accessKeyId: requiredEnv("AWS_ACCESS_KEY_ID"), secretAccessKey: requiredEnv("AWS_SECRET_ACCESS_KEY") };
  const ses = new SESClient({ region, credentials });
  const cw = new CloudWatchClient({ region, credentials });
  const now = new Date();
  const start = new Date(now.getTime() - days * 86400000);
  // the IST days in the window, oldest first
  const dayList = Array.from({ length: days }, (_, i) => istDay(new Date(now.getTime() - (days - 1 - i) * 86400000)));

  const quota = section(async () => {
    const q = await ses.send(new GetSendQuotaCommand({}));
    const max = q.Max24HourSend ?? 0;
    const sent = q.SentLast24Hours ?? 0;
    return { sentLast24h: sent, max24h: max, remaining: Math.max(0, max - sent), usedPct: max ? (100 * sent) / max : 0, maxSendRate: q.MaxSendRate ?? 0 };
  });

  const sendPoints = ses.send(new GetSendStatisticsCommand({})).then((r) => r.SendDataPoints ?? []);

  const daily = section(async () => {
    const r = { SendDataPoints: await sendPoints };
    const byDay = new Map(dayList.map((d) => [d, { day: d, sends: 0, bounces: 0, complaints: 0, rejects: 0 }]));
    for (const p of r.SendDataPoints ?? []) {
      const row = byDay.get(istDay(new Date(p.Timestamp!)));
      if (!row) continue;
      row.sends += p.DeliveryAttempts ?? 0;
      row.bounces += p.Bounces ?? 0;
      row.complaints += p.Complaints ?? 0;
      row.rejects += p.Rejects ?? 0;
    }
    return [...byDay.values()];
  });

  // One CloudWatch call for both reputation rates and the validation verdicts.
  const metrics = section(async () => {
    const q = (id: string, metric: string, stat: string, period: number): MetricDataQuery => ({
      Id: id,
      MetricStat: { Metric: { Namespace: "AWS/SES", MetricName: metric }, Period: period, Stat: stat },
    });
    const r = await cw.send(new GetMetricDataCommand({
      StartTime: start,
      EndTime: now,
      ScanBy: "TimestampAscending",
      MetricDataQueries: [
        q("bounce", "Reputation.BounceRate", "Maximum", 3600),
        q("complaint", "Reputation.ComplaintRate", "Maximum", 3600),
        q("high", "EmailAddressInsights.ConfidenceVerdict.HIGH", "Sum", 3600),
        q("medium", "EmailAddressInsights.ConfidenceVerdict.MEDIUM", "Sum", 3600),
        q("low", "EmailAddressInsights.ConfidenceVerdict.LOW", "Sum", 3600),
      ],
    }));
    const series = (id: string) => {
      const s = (r.MetricDataResults ?? []).find((m) => m.Id === id);
      return (s?.Timestamps ?? []).map((t, i) => ({ t: new Date(t).toISOString(), v: s?.Values?.[i] ?? 0 }));
    };
    const rate = (id: string) => {
      const pts = series(id).map((p) => ({ t: p.t, pct: p.v * 100 }));
      return { current: pts.length ? pts[pts.length - 1].pct : null, peak: pts.reduce((m, p) => Math.max(m, p.pct), 0), points: pts };
    };
    const perDay = new Map(dayList.map((d) => [d, { day: d, low: 0, medium: 0, high: 0 }]));
    const totals = { low: 0, medium: 0, high: 0 };
    for (const level of ["low", "medium", "high"] as const) {
      for (const p of series(level)) {
        totals[level] += p.v;
        const row = perDay.get(istDay(new Date(p.t)));
        if (row) row[level] += p.v;
      }
    }
    return {
      reputation: { bounce: rate("bounce"), complaint: rate("complaint") },
      validation: { totals, daily: [...perDay.values()] },
    };
  });

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  // Hourly sends for the chart: Overall from SES (every mail, like the console),
  // Newsletter and Welcome from our own records -- SES has no such split.
  const hourly = section(async () => {
    // IST hours (xx:00 IST = xx:30 UTC), so the chart reads 9:00-10:00, not 9:30-10:30.
    const HALF = 1800000;
    const hourOf = (d: Date) => Math.floor((d.getTime() + HALF) / 3600000) * 3600000 - HALF;
    const first = hourOf(start), last = hourOf(now);
    const rows = new Map<number, { t: string; overall: number; newsletter: number; welcome: number }>();
    for (let h = first; h <= last; h += 3600000) rows.set(h, { t: new Date(h).toISOString(), overall: 0, newsletter: 0, welcome: 0 });
    for (const p of await sendPoints) {
      const row = rows.get(hourOf(new Date(p.Timestamp!)));
      if (row) row.overall += p.DeliveryAttempts ?? 0;
    }
    const { data, error } = await supabase.rpc("send_counts_hourly", { p_from: new Date(first).toISOString(), p_to: now.toISOString() });
    if (!error) {
      for (const r of (data ?? []) as Array<{ hour: string; newsletter: number; welcome: number }>) {
        const row = rows.get(hourOf(new Date(r.hour)));
        if (row) { row.newsletter = Number(r.newsletter); row.welcome = Number(r.welcome); }
      }
    } else {
      // Before migration 20261106_send_counts_hourly: count the rows here.
      const count = async (table: string, col: string, key: "newsletter" | "welcome", extra?: (q: any) => any) => {
        const { data: got, error: e } = await fetchAllRows<Record<string, string>>((from, to) => {
          let q = supabase.from(table).select(`id,${col}`).gte(col, new Date(first).toISOString()).order("id").range(from, to);
          if (extra) q = extra(q);
          return q;
        });
        if (e) throw new Error(e.message);
        for (const r of got) {
          const row = rows.get(hourOf(new Date(r[col])));
          if (row) row[key]++;
        }
      };
      await count("email_outbox", "sent_at", "newsletter", (q) => q.eq("status", "sent"));
      await count("subscribers", "welcome_sent_at", "welcome");
    }
    return [...rows.values()];
  });

  const suppression = section(async () => {
    const { data, error } = await fetchAllRows<{ email: string; event_type: string; received_at: string; bounce_type: string | null; bounce_sub: string | null; subject: string | null }>((from, to) =>
      supabase.from("email_events")
        .select("email,event_type,received_at,bounce_type,bounce_sub,subject:raw->mail->commonHeaders->>subject")
        .or("event_type.eq.complaint,and(event_type.eq.bounce,bounce_type.eq.Permanent)")
        .order("id").range(from, to));
    if (error) throw new Error(error.message);
    // SES Auto Validation blocks also arrive as Permanent bounces, but those
    // were never sent and SES does not suppress them -- leave them out.
    const SKIP = new Set(["EmailValidationSuppressed", "OnAccountSuppressionList", "Suppressed"]);
    const latest = new Map<string, { email: string; reason: string; added: string; mail: string }>();
    for (const e of data) {
      if (e.event_type === "bounce" && SKIP.has(e.bounce_sub ?? "")) continue;
      const email = String(e.email).toLowerCase();
      const prev = latest.get(email);
      if (prev && prev.added >= e.received_at) continue;
      const subject = e.subject ?? "";
      latest.set(email, {
        email,
        reason: e.event_type === "complaint" ? "Complaint" : "Bounce",
        added: e.received_at,
        mail: /part of the club/i.test(subject) ? "Welcome mail" : /Wrap is here/i.test(subject) ? `Newsletter (${subject.split(" - ")[0]})` : subject.slice(0, 60),
      });
    }
    const rows = [...latest.values()].sort((a, b) => b.added.localeCompare(a.added));
    return { count: rows.length, rows };
  });

  const [q, d, m, s, h] = await Promise.all([quota, daily, metrics, suppression, hourly]);
  const mOk = m as { reputation?: unknown; validation?: unknown; error?: string };
  return json({
    generated_at: now.toISOString(),
    days,
    quota: q,
    daily: d,
    hourly: h,
    reputation: mOk.error ? { error: mOk.error } : mOk.reputation,
    validation: mOk.error ? { error: mOk.error } : mOk.validation,
    suppression: s,
  });
});
