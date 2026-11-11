// welcome-pool: the dashboard's "Welcome queue" panel (Subscribers page).
// A bulk list goes into welcome_pool once; release-welcome-pool sends the next
// `daily_limit` of them every day at 12:00 IST, with nobody's computer on.
//
//   POST {"action":"status"}
//   POST {"action":"preview","subscribers":[{email, full_name}]}   counts only, writes nothing
//   POST {"action":"add","subscribers":[...],"daily_limit":250?}   queue the new ones (+ set the limit)
//   POST {"action":"set-limit","daily_limit":300}
//
// The pre-check here is the cheap one (format, Gmail-only rules, repeats,
// already on the list / never-send / already queued). The full checks and the
// SES validation run on release, through the same import-batch as any upload.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { staticVerify } from "../_shared/email-verify.ts";
import { istDate } from "../_shared/report-mail.ts";
import { fetchAllRows } from "../_shared/page.ts";

// deno-lint-ignore no-explicit-any
type Client = any;

// import-batch refuses anything past DAILY_BATCH_MAX in a day, so a higher
// daily limit would only drop addresses: never allow one.
const systemCap = () => Number(Deno.env.get("DAILY_BATCH_MAX")) || 2500;

async function present(supabase: Client, table: string, emails: string[], extra?: (q: Client) => Client) {
  const found = new Set<string>();
  for (let i = 0; i < emails.length; i += 100) {
    let q = supabase.from(table).select("email").in("email", emails.slice(i, i + 100));
    if (extra) q = extra(q);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    for (const r of data ?? []) found.add(String(r.email).toLowerCase());
  }
  return found;
}

async function sortOut(supabase: Client, rows: Array<{ email?: unknown; full_name?: unknown }>) {
  const byEmail = new Map<string, string | null>();
  let duplicates = 0;
  const notGmail: string[] = [], invalid: string[] = [];
  for (const row of rows) {
    const parts = String(row?.email ?? "").toLowerCase().split(/[,;\s/]+/).map((p) => p.trim()).filter(Boolean);
    for (const email of parts) {
      const fail = staticVerify(email);
      if (fail) {
        (fail.code === "precheck_domain" ? notGmail : invalid).push(email);
        continue;
      }
      if (byEmail.has(email)) { duplicates++; continue; }
      byEmail.set(email, String(row?.full_name ?? "").trim() || null);
    }
  }
  const emails = [...byEmail.keys()];
  const [subs, supp, queued] = await Promise.all([
    present(supabase, "subscribers", emails),
    present(supabase, "email_suppressions", emails),
    present(supabase, "welcome_pool", emails),
  ]);
  const fresh = emails.filter((e) => !subs.has(e) && !supp.has(e) && !queued.has(e));
  return {
    counts: {
      unique: emails.length + new Set([...notGmail, ...invalid]).size,
      duplicates,
      not_gmail: new Set(notGmail).size,
      invalid: new Set(invalid).size,
      already_subscriber: emails.filter((e) => subs.has(e)).length,
      on_never_send: emails.filter((e) => !subs.has(e) && supp.has(e)).length,
      already_queued: emails.filter((e) => !subs.has(e) && !supp.has(e) && queued.has(e)).length,
      new: fresh.length,
    },
    fresh: fresh.map((e) => ({ email: e, full_name: byEmail.get(e) ?? null })),
  };
}

async function status(supabase: Client) {
  const [{ data: s }, { count: waiting }, released] = await Promise.all([
    supabase.from("welcome_pool_settings").select("daily_limit,updated_at").eq("id", true).maybeSingle(),
    supabase.from("welcome_pool").select("email", { count: "exact", head: true }).is("released_on", null),
    fetchAllRows<{ released_on: string }>((from, to) =>
      supabase.from("welcome_pool").select("released_on").not("released_on", "is", null).order("released_on").order("email").range(from, to)),
  ]);
  if (released.error) throw new Error(released.error.message);
  const perDay = new Map<string, number>();
  for (const r of released.data) perDay.set(r.released_on, (perDay.get(r.released_on) ?? 0) + 1);
  const limit = Number(s?.daily_limit ?? 250);
  const w = waiting ?? 0;
  return {
    daily_limit: limit,
    limit_updated_at: s?.updated_at ?? null,
    system_cap: systemCap(),
    waiting: w,
    released_total: released.data.length,
    days_left: limit > 0 ? Math.ceil(w / limit) : null,
    releases: [...perDay.entries()].map(([day, count]) => ({ day, count })).reverse().slice(0, 14),
    today: istDate(0),
    runs_at: "12:00 PM IST daily",
  };
}

async function setLimit(supabase: Client, value: unknown) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) throw new Error("Enter a daily number of 1 or more.");
  if (n > systemCap()) throw new Error(`The system allows at most ${systemCap()} new addresses a day (DAILY_BATCH_MAX). Choose ${systemCap()} or less.`);
  const { error } = await supabase.from("welcome_pool_settings").update({ daily_limit: n, updated_at: new Date().toISOString() }).eq("id", true);
  if (error) throw new Error(error.message);
  return n;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const denied = await requireAgent(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  const action = String(body?.action ?? "status");
  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  try {
    if (action === "status") return json(await status(supabase));
    if (action === "set-limit") {
      const n = await setLimit(supabase, body?.daily_limit);
      return json({ ok: true, daily_limit: n, ...(await status(supabase)) });
    }
    const rows = Array.isArray(body?.subscribers) ? body.subscribers : [];
    if (action === "preview" || action === "add") {
      if (!rows.length) return json({ error: "No addresses found in the files." }, 400);
      if (rows.length > 20000) return json({ error: "Add at most 20,000 rows at a time." }, 400);
      const { counts, fresh } = await sortOut(supabase, rows);
      if (action === "preview") return json({ ok: true, counts });
      if (body?.daily_limit !== undefined && body?.daily_limit !== null && body?.daily_limit !== "") {
        await setLimit(supabase, body.daily_limit);
      }
      const source = String(body?.source ?? "dashboard upload").slice(0, 200);
      const now = Date.now();
      for (let i = 0; i < fresh.length; i += 500) {
        // added_at keeps the file order, so the first rows go out first.
        const chunk = fresh.slice(i, i + 500).map((r, j) => ({ ...r, source, added_at: new Date(now + i + j).toISOString() }));
        const { error } = await supabase.from("welcome_pool").upsert(chunk, { onConflict: "email", ignoreDuplicates: true });
        if (error) throw new Error(error.message);
      }
      return json({ ok: true, counts, queued: fresh.length, ...(await status(supabase)) });
    }
    return json({ error: `Unknown action "${action}".` }, 400);
  } catch (e) {
    console.error(JSON.stringify({ tag: "welcome-pool", error: String(e).slice(0, 300) }));
    return json({ error: String(e).slice(0, 300) }, 400);
  }
});
