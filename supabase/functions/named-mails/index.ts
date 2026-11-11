// named-mails: the dashboard "Domain mails" box (SES stats page, admin only).
// Non-Gmail addresses the owner adds personally, because the owner knows they
// are real. They are mailed through SES_NAMED_CONFIGURATION_SET (Domain-mails,
// Auto Validation off) instead of the strict account-wide HIGH check.
//
//   POST {"action":"list"}
//   POST {"action":"check","email":"a@company.com"}     SES Email Validation ($0.01)
//   POST {"action":"add","email":"...","approve":false}   add + send the welcome
//   POST {"action":"remove","email":"..."}
//
// Owner rule (2026-11-07), applied by `check` and enforced again by `add`:
//   mailbox exists HIGH/MEDIUM and overall HIGH/MEDIUM  -> ok, send
//   mailbox exists HIGH/MEDIUM and overall LOW          -> only with approval
//   mailbox exists LOW                                  -> only with approval (warning)
// Never re-added: addresses that complained, unsubscribed or hard-bounced.
//
// Same two locks as ses-stats: requireAgent() + ADMIN_STATS_TOKEN.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { emailInsight } from "../_shared/ses-insights.ts";
import { forgetNamedAddresses, isFromSecret } from "../_shared/named.ts";
import { sendWelcomeEmail } from "../_shared/welcome-send.ts";

// deno-lint-ignore no-explicit-any
type Client = any;

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;
// never-send reasons that only mean "SES or our pre-check doubted it" -- the
// owner's word overrides those. Anything else is a real opt-out or bounce.
const CLEARABLE = new Set(["ses_auto_validation", "ses_medium_confidence", "ses_low_confidence", "ses_mailbox_low", "precheck_domain", "precheck_validity"]);
const HARD_BLOCK: Record<string, string> = {
  complaint: "marked our mail as spam",
  unsubscribed: "unsubscribed",
  hard_bounce: "hard-bounced (the mailbox rejected our mail)",
  repeated_soft_bounce: "bounced repeatedly with nothing delivered",
};

function sameText(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type Decision = "ok" | "approve_low_overall" | "approve_mailbox_low";

function decide(overall: string | null, mailbox: string | null): Decision {
  if (mailbox !== "HIGH" && mailbox !== "MEDIUM") return "approve_mailbox_low";
  if (overall === "LOW") return "approve_low_overall";
  return "ok";
}

async function state(supabase: Client, email: string) {
  const [{ data: sub }, { data: supp }, { data: named }] = await Promise.all([
    supabase.from("subscribers").select("id,status,verification_status,welcome_sent_at").eq("email", email).maybeSingle(),
    supabase.from("email_suppressions").select("reason").eq("email", email),
    supabase.from("named_addresses").select("email").eq("email", email).maybeSingle(),
  ]);
  const reasons = (supp ?? []).map((r: { reason: string }) => r.reason);
  const blocked = reasons.find((r: string) => HARD_BLOCK[r]);
  return {
    subscriber: sub ?? null,
    reasons,
    blocked: blocked ? `This address ${HARD_BLOCK[blocked]}, so it is never mailed again.` : null,
    alreadyNamed: !!named || isFromSecret(email),
  };
}

async function check(supabase: Client, email: string) {
  const s = await state(supabase, email);
  const insight = await emailInsight(email);
  return {
    email,
    overall: insight.isValid,
    mailbox: insight.mailboxExists,
    decision: decide(insight.isValid, insight.mailboxExists),
    blocked: s.blocked,
    already_named: s.alreadyNamed,
    welcome_sent: !!s.subscriber?.welcome_sent_at,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const denied = await requireAgent(request);
  if (denied) return denied;
  const adminToken = Deno.env.get("ADMIN_STATS_TOKEN") ?? "";
  if (!adminToken) return json({ error: "Admin tools are not set up yet (ADMIN_STATS_TOKEN)." }, 503);
  if (!sameText((request.headers.get("x-admin-token") ?? "").trim(), adminToken)) {
    return json({ error: "Wrong admin password." }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const action = String(body?.action ?? "list");
  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  try {
    if (action === "list") {
      const { data, error } = await supabase.from("named_addresses").select("*").order("added_at", { ascending: false }).order("email");
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      const emails = new Set(rows.map((r) => String(r.email)));
      for (const e of (Deno.env.get("ALLOWED_EMAIL_ADDRESSES") ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
        if (!emails.has(e)) rows.push({ email: e, note: "From the ALLOWED_EMAIL_ADDRESSES secret", added_by: "secret", from_secret: true });
      }
      const all = rows.map((r) => String(r.email));
      const { data: subs } = all.length
        ? await supabase.from("subscribers").select("email,status,welcome_sent_at").in("email", all)
        : { data: [] };
      const byEmail = new Map((subs ?? []).map((s: { email: string }) => [s.email.toLowerCase(), s]));
      return json({
        named_set: Deno.env.get("SES_NAMED_CONFIGURATION_SET") ?? null,
        rows: rows.map((r) => ({ ...r, from_secret: !!r.from_secret || isFromSecret(String(r.email)), subscriber: byEmail.get(String(r.email)) ?? null })),
      });
    }

    const email = String(body?.email ?? "").trim().toLowerCase();
    if (!EMAIL.test(email)) return json({ error: "Enter one valid email address." }, 400);
    if (email.endsWith("@gmail.com")) {
      return json({ error: "Gmail addresses go through the normal upload, not the domain-mails list." }, 400);
    }

    if (action === "check") return json(await check(supabase, email));

    if (action === "remove") {
      if (isFromSecret(email)) {
        return json({ error: "This one comes from the ALLOWED_EMAIL_ADDRESSES secret; change it with `supabase secrets set`." }, 400);
      }
      const { error } = await supabase.from("named_addresses").delete().eq("email", email);
      if (error) throw new Error(error.message);
      forgetNamedAddresses();
      return json({ ok: true, removed: email });
    }

    if (action === "add") {
      // Checked again here, so the rule holds even if the page is bypassed.
      const c = await check(supabase, email);
      if (c.blocked) return json({ ...c, error: c.blocked }, 409);
      if (c.decision !== "ok" && body?.approve !== true) {
        return json({ ...c, error: "Needs your approval first.", needs_approval: true }, 409);
      }
      if (!Deno.env.get("SES_NAMED_CONFIGURATION_SET")) {
        return json({ error: "SES_NAMED_CONFIGURATION_SET is not set, so this address would hit the strict check." }, 503);
      }

      const { error: nErr } = await supabase.from("named_addresses").upsert({
        email,
        ses_overall: c.overall,
        ses_mailbox: c.mailbox,
        approved_override: c.decision !== "ok",
        note: c.decision === "ok" ? "Passed SES check" : `Owner approved (${c.decision === "approve_low_overall" ? "overall LOW" : "mailbox LOW"})`,
        added_by: "dashboard",
      }, { onConflict: "email" });
      if (nErr) throw new Error(nErr.message);
      forgetNamedAddresses();

      // The owner's word overrides SES / pre-check doubts, never a real opt-out.
      const s = await state(supabase, email);
      const clear = s.reasons.filter((r: string) => CLEARABLE.has(r));
      if (clear.length) {
        const { error } = await supabase.from("email_suppressions").delete().eq("email", email).in("reason", clear);
        if (error) throw new Error(error.message);
      }
      // Separate statement from the delete above: the suppression trigger reads
      // the never-send list when the row is written.
      let subscriber = s.subscriber;
      const reason = `Owner-named domain mail (${new Date().toISOString().slice(0, 10)})`;
      if (!subscriber) {
        const { data, error } = await supabase.from("subscribers").insert({
          email, plan: "daily-wrap", category: null, topics: ["daily-wrap"], rhythm: "daily", status: "subscribed",
          verification_status: "valid", verified_at: new Date().toISOString(), verification_reason: reason,
        }).select("id,status,verification_status,welcome_sent_at").single();
        if (error) throw new Error(error.message);
        subscriber = data;
      } else if (subscriber.status !== "subscribed" || subscriber.verification_status !== "valid") {
        // An earlier SES block also marks verification "invalid", and the
        // newsletter skips invalid addresses -- clear both (balaji.g@ missed
        // the 11 Nov newsletter this way).
        const { data, error } = await supabase.from("subscribers").update({
          status: "subscribed", unsubscribed_at: null, verification_status: "valid", verification_reason: reason, updated_at: new Date().toISOString(),
        }).eq("id", subscriber.id).select("id,status,verification_status,welcome_sent_at").single();
        if (error) throw new Error(error.message);
        subscriber = data;
      }

      if (subscriber.welcome_sent_at) {
        return json({ ...c, ok: true, added: true, welcome: { sent: false, skipped: true, reason: "already welcomed" } });
      }
      const welcome = await sendWelcomeEmail(email, null);
      if (welcome.ok) {
        await supabase.from("subscribers").update({ welcome_sent_at: new Date().toISOString() }).eq("id", subscriber.id);
      }
      return json({ ...c, ok: true, added: true, welcome: { sent: !!welcome.ok, messageId: welcome.messageId ?? null, error: welcome.error ?? null } });
    }

    return json({ error: `Unknown action "${action}".` }, 400);
  } catch (e) {
    console.error(JSON.stringify({ tag: "named-mails", error: String(e).slice(0, 300) }));
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
