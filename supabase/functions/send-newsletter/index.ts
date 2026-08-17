// send-newsletter: one coordinated daily send that serves every subscriber plan.
//
// Plans (subscribers.plan + subscribers.category):
//   daily-wrap     -> 10 Daily Wrap stories
//   category-case  -> 5 shorts from their category + 1 case study from their category
//   wrap-category  -> 5 Daily Wrap + 5 shorts from their category
//   case-only      -> 1 case study from their category
//
// Content pools are everything currently `approved` and unsent:
//   Daily Wrap   -> today's articles (status=approved, category IS NULL)
//   Cat. shorts  -> today's articles (status=approved, category = X)
//   Case study   -> today's editorial_drafts (status=approved), newest per topic
//
// Fired by pg_cron at 09:00 IST. Idempotent per IST day.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { sendEmail } from "../_shared/mailer.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { renderPrivacyFooter } from "../_shared/privacy.ts";
import { buildWrapOrder } from "../_shared/editorial-picks.ts";
import { renderIntroEmail, INTRO_SUBJECT } from "../_shared/intro-email.ts";

type Article = {
  id: string;
  title: string;
  edited_title: string | null;
  url: string;
  summary: string | null;
  edited_summary: string | null;
  source: string | null;
  topic: string | null;
  category: string | null;
  rank_score: number | null;
  // Editor prominence 1-5 from the summarizer. Feeds editorial selection.
  prominence: number | null;
  fact_score: number | null;
  fact_label: string | null;
  fact_notes: { source_count?: number; sources?: Array<{ source: string; url: string }> } | null;
  scraped_at: string;
  published_at: string | null;
  reviewed_at: string | null;
  // Scrape-time breaking marker (Latest/Live/Breaking section, headline or URL).
  breaking_flag?: boolean | null;
  // Flagged from the breaking_news view: prominence x cross-outlet velocity x
  // fact trust, freshness-decayed. One input to editorial selection.
  is_breaking?: boolean;
};

type CaseStudy = {
  kind: "editorial";
  id: string;
  category: string;
  headline: string;
  summary: string;
  detail: string;
  source: string | null;
  source_url: string | null;
};

type Subscriber = {
  id: string;
  email: string;
  full_name: string | null;
  plan: string | null;
  category: string | null;
};

const CATEGORIES = ["Real Estate", "Automobile", "Health & Wellness", "Tech & AI", "Markets & Startups"];
const CATEGORY_TO_SLUG: Record<string, string> = {
  "Real Estate": "real-estate",
  "Automobile": "automobile",
  "Health & Wellness": "health-wellness",
  "Tech & AI": "tech-ai",
  "Markets & Startups": "markets-startups",
};

const WRAP_COUNT = 5;
const WRAP_SPLIT = 5;
const CATEGORY_SPLIT = 5;
const CATEGORY_CASE_SHORTS = 5;
const MAX_EMAIL_BREAKING = 3;

const BANNER_URL =
  Deno.env.get("SHORTLY_BANNER_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/figma-email-banner.png";
const FOOTER_LOGO_URL =
  Deno.env.get("SHORTLY_FOOTER_LOGO_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/dailymattr-primary-logo.png";
const INSTAGRAM_ICON_URL = "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/icon-instagram.png";
const GOOGLE_PLAY_ICON_URL = "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/icon-google-play.png";
const APP_STORE_ICON_URL = "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/icon-app-store.png";
const INSTAGRAM_URL = "https://www.instagram.com/dailymattr/";
const X_URL = "https://x.com/dailymattr_news";
const LINKEDIN_URL = "https://www.linkedin.com/company/https-www.dailymattr.com-/";
const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.dailymattr";
const SITE_URL = (Deno.env.get("SHORTLY_SITE_URL") ?? "").replace(/\/+$/, "");

function istDayWindow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const startMs = Date.UTC(value("year"), value("month") - 1, value("day")) - (5.5 * 60 * 60 * 1000);
  const endMs = startMs + (24 * 60 * 60 * 1000);
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Server-side auth: service_role JWT (cron) or the dashboard's agent token.
  const denied = await requireAgent(request);
  if (denied) return denied;


  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  let subscriberIds: string[] = [];
  let isScheduled = false;
  let forceSend = false;
  let testEmail: string | null = null;
  let provider: "ses" | "brevo" | undefined;
  let recipients: Array<Record<string, unknown>> = [];
  // ---- HIGH-VOLUME MODES ----
  // The default path sends inside the request. Measured at ~11.7 emails/sec,
  // that tops out near 1,700 recipients before the edge budget expires -- and it
  // dies with no resume point, so a retry re-sends whoever already got one.
  //
  // At 50k these two modes replace it:
  //   {"plan":true}            -> write one email_outbox row per recipient and
  //                               return. One bulk insert, finishes in seconds.
  //   {"drain":true,"limit":N} -> claim N rows via claim_email_batch(), render
  //                               and send them, record the outcome per row.
  // Progress then lives in rows, so a crash resumes exactly where it stopped and
  // FOR UPDATE SKIP LOCKED stops two workers taking the same recipient.
  //
  // Both live in THIS function on purpose: the templates are here, and a worker
  // in a separate function would either duplicate them or need the renderer
  // extracted, which is a much riskier change to the live send path.
  let planOnly = false;
  let drain = false;
  let drainLimit = 500;
  // One-off announcement to people who were ADDED to the list rather than
  // signing up. {"intro_to":"a@b.com"} sends a single preview; {"intro":true}
  // sends to every subscribed address. Runs BEFORE the content pools are
  // loaded, because it carries no articles and must not depend on the day
  // having any approved content.
  let intro = false;
  let introTo: string | null = null;
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    subscriberIds = Array.isArray(body?.subscriber_ids)
      ? body.subscriber_ids.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    isScheduled = body?.scheduled === true;
    forceSend = body?.force === true;
    testEmail = typeof body?.test_email === "string" && body.test_email.includes("@") ? body.test_email : null;
    provider = body?.provider === "brevo" ? "brevo" : body?.provider === "ses" ? "ses" : undefined;
    recipients = Array.isArray(body?.recipients) ? body.recipients : [];
    planOnly = body?.plan === true;
    drain = body?.drain === true;
    drainLimit = Math.min(1000, Math.max(1, Number(body?.limit) || 500));
    intro = body?.intro === true;
    introTo = typeof body?.intro_to === "string" && body.intro_to.includes("@") ? body.intro_to : null;
  }

  // A test address is a single-recipient override. Never route it through the
  // normal subscriber loops, which would send one copy per subscriber.
  if (testEmail && recipients.length === 0) {
    recipients = [{ email: testEmail, plan: "daily-wrap" }];
  }

  // ---- INTRO: one-off announcement, no articles involved -------------------
  if (intro || introTo) {
    // Preview to one address first. This is a one-shot broadcast that every
    // colleague sees once, so there is no second chance to fix a typo.
    const targets: Array<{ id: string | null; email: string; full_name: string | null }> = [];
    if (introTo) {
      targets.push({ id: null, email: introTo, full_name: null });
    } else {
      // Page it: a bare select is capped by PostgREST max-rows, which would
      // silently mail only the first page and report success.
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data: subs, error: sErr } = await supabase
          .from("subscribers")
          .select("id,email,full_name")
          .eq("status", "subscribed")
          .order("id")
          .range(from, from + PAGE - 1);
        if (sErr) return json({ error: sErr.message }, 500);
        const page = (subs ?? []) as Array<{ id: string; email: string; full_name: string | null }>;
        if (page.length === 0) break;
        for (const s of page) targets.push({ id: s.id, email: s.email, full_name: s.full_name });
        if (page.length < PAGE) break;
      }
    }
    if (targets.length === 0) return json({ mode: "intro", sent: 0, failed: 0, reason: "no subscribers" });

    let iSent = 0;
    let iFailed = 0;
    const failures: Array<Record<string, unknown>> = [];
    const messageIds: Array<{ email: string; messageId: string | null }> = [];
    // Same grouping the drain path uses: bursting is what got 67/100 delivered
    // in the load test.
    const GROUP = 10;
    for (let i = 0; i < targets.length; i += GROUP) {
      const group = targets.slice(i, i + GROUP);
      await Promise.all(group.map(async (t) => {
        try {
          const html = await renderIntroEmail(t.email, t.full_name);
          const result = await sendEmail({ to: t.email, subject: INTRO_SUBJECT, html, provider });
          // Record the provider message id. Without it an intro send is
          // untraceable: "sent: 1" only means SES accepted the call, and when a
          // recipient says it never arrived there is no id to look up in the
          // SES console and nothing for the bounce webhook to attach to. The
          // wrap path has always written this row; the intro path did not.
          messageIds.push({ email: t.email, messageId: result.messageId ?? null });
          if (result.ok) iSent++; else { iFailed++; failures.push({ email: t.email, error: result.error }); }
        } catch (e) {
          iFailed++;
          failures.push({ email: t.email, error: String(e).slice(0, 200) });
        }
      }));
    }
    return json({
      mode: introTo ? "intro-preview" : "intro",
      recipients: targets.length,
      sent: iSent,
      failed: iFailed,
      failures: failures.slice(0, 5),
      // Returned for single-recipient previews so the id can be looked up in the
      // SES console; truncated on bulk sends to keep the response small.
      messageIds: messageIds.slice(0, 10),
    });
  }

  const { start: istStart, end: istEnd } = istDayWindow();

  // Idempotency: one scheduled send per IST day (unless forced).
  if (isScheduled && !forceSend) {
    const { data: existing } = await supabase
      .from("digests")
      .select("id,sent_at,recipients")
      .gte("sent_at", istStart)
      .lt("sent_at", istEnd)
      .gt("recipients", 0)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      return json({ skipped: true, reason: "Newsletter already sent for the current IST day.", digestId: existing.id });
    }
  }

  // ---- 1. Load approved (unsent) content pools ----
  const { data: approvedArticles, error: articlesError } = await supabase
    .from("articles")
    .select("id,title,edited_title,url,summary,edited_summary,source,topic,category,rank_score,prominence,fact_score,fact_label,fact_notes,published_at,scraped_at,reviewed_at,breaking_flag")
    .eq("status", "approved")
    .gte("reviewed_at", istStart)
    .lt("reviewed_at", istEnd)
    .order("scraped_at", { ascending: false })
    .order("rank_score", { ascending: false })
    .limit(500);
  if (articlesError) return json({ error: articlesError.message }, 500);

  let wrapPool: Article[] = [];
  const categoryPool: Record<string, Article[]> = {};
  for (const cat of CATEGORIES) categoryPool[cat] = [];
  for (const a of (approvedArticles ?? []) as Article[]) {
    if (a.category && categoryPool[a.category]) categoryPool[a.category].push(a);
    else if (!a.category) wrapPool.push(a);
  }

  // Mark the day's qualifying breaking stories from the breaking_news view
  // (prominence x cross-outlet velocity x fact trust). This is now one INPUT to
  // editorial selection rather than the ordering itself. Non-fatal.
  try {
    const { data: brk } = await supabase
      .from("breaking_news")
      .select("id,breaking_score")
      .in("status", ["approved", "sent"])
      .order("breaking_score", { ascending: false });
    const brkScore = new Map((brk ?? []).map((r: any) => [r.id as string, Number(r.breaking_score)]));
    if (brkScore.size > 0) {
      wrapPool = wrapPool.map((a) => (brkScore.has(a.id) ? { ...a, is_breaking: true } : a));
    }
  } catch { /* breaking is optional */ }

  // Flag consensus needs the SIBLINGS' breaking flags, not just this article's.
  // One lookup over every corroborating URL the fact-check recorded lets Class A
  // ask "what share of the outlets carrying this flagged it breaking?" for real.
  // Non-fatal: without it, selection falls back to saturation breadth alone.
  const flagByUrl = new Map<string, boolean | null>();
  try {
    const siblingUrls = [...new Set(
      wrapPool.flatMap((a) => (a.fact_notes?.sources ?? []).map((s) => s?.url).filter(Boolean) as string[]),
    )].slice(0, 500);
    if (siblingUrls.length > 0) {
      const { data: flagRows } = await supabase
        .from("articles")
        .select("url,breaking_flag")
        .in("url", siblingUrls);
      for (const r of (flagRows ?? []) as Array<{ url: string; breaking_flag: boolean | null }>) {
        flagByUrl.set(r.url, r.breaking_flag);
      }
    }
  } catch { /* sibling flags are optional */ }

  // EDITORIAL SELECTION: order the pool so the first WRAP_COUNT entries are the
  // wrap â€” consensus breaking first (max 3), then one qualified explainer, then
  // important-people / viral stories, deduped by event, capped per topic, tonal
  // check applied, strongest first with the most distinct story last. Falls back
  // to the pool untouched if the judgement pass fails, so a bad classification
  // can never cost us the send.
  // Deterministic same-event detection from the title embeddings, computed in
  // Postgres (pgvector) rather than shipping 1536-float vectors to the edge.
  // This is the layer that survives an LLM outage: the threshold is calibrated
  // so every hit is a genuine duplicate. Non-fatal — without it, dedupe simply
  // falls back to the event key and token overlap.
  const dupPairs = new Map<string, Set<string>>();
  try {
    const { data: pairs } = await supabase.rpc("wrap_duplicate_pairs", {
      p_ids: wrapPool.map((a) => a.id),
      p_max_distance: Number(Deno.env.get("WRAP_DUP_MAX_DISTANCE") ?? 0.40),
    });
    for (const p of (pairs ?? []) as Array<{ id_a: string; id_b: string }>) {
      if (!dupPairs.has(p.id_a)) dupPairs.set(p.id_a, new Set());
      if (!dupPairs.has(p.id_b)) dupPairs.set(p.id_b, new Set());
      dupPairs.get(p.id_a)!.add(p.id_b);
      dupPairs.get(p.id_b)!.add(p.id_a);
    }
  } catch { /* embedding dedupe is a safety net, never a requirement */ }

  const wrapOrder = await buildWrapOrder(wrapPool, {
    apiKey: Deno.env.get("OPENAI_API_KEY") ?? undefined,
    model: Deno.env.get("SUMMARIZE_MODEL") ?? "gpt-4o-mini",
    slots: WRAP_COUNT,
    flagByUrl,
    dupPairs,
  });
  wrapPool = limitBreakingStories(wrapOrder.pool as Article[]);

  // Explicit one-recipient tests may intentionally use an approved case from
  // the active pool even when it was approved before today's scrape window.
  const caseStudies = await loadCaseStudies(supabase, istStart, istEnd, recipients.length > 0);

  // ---- DRAIN: send a slice of the outbox ----------------------------------
  // Claims via claim_email_batch(), which uses FOR UPDATE SKIP LOCKED, so this
  // is safe to run many times concurrently. Each row is marked individually,
  // so a timeout mid-batch loses nothing: unfinished rows stay 'sending' and
  // are re-claimed after the stale window.
  if (drain) {
    const { data: claimed, error: claimErr } = await supabase
      .rpc("claim_email_batch", { p_limit: drainLimit, p_stale_minutes: 10 });
    if (claimErr) return json({ error: claimErr.message }, 500);
    const rows = (claimed ?? []) as Array<Record<string, any>>;
    if (rows.length === 0) return json({ mode: "drain", claimed: 0, sent: 0, failed: 0, done: true });

    let dSent = 0;
    let dFailed = 0;
    const sd = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });

    // Small parallel groups: fast enough to clear the slice, slow enough to stay
    // under the provider's per-second rate. Bursting is what got 67/100
    // delivered in the 2026-08-15 load test.
    const GROUP = 10;
    for (let i = 0; i < rows.length; i += GROUP) {
      const group = rows.slice(i, i + GROUP);
      await Promise.all(group.map(async (row) => {
        try {
          const plan = String(row.plan ?? "daily-wrap");
          const cat = row.category as string | null;
          const selection = selectFor(plan, cat, cat, wrapPool, categoryPool, caseStudies);
          if (selection.wrap.length === 0 && selection.shorts.length === 0 && !selection.caseStudy) {
            await supabase.from("email_outbox")
              .update({ status: "skipped", error: "no matching approved content" })
              .eq("id", row.id);
            return;
          }
          const html = await renderEmail(
            { id: row.subscriber_id ?? "", email: row.email, full_name: row.full_name ?? null, plan, category: cat },
            plan,
            selection,
          );
          const result = await sendEmail({
            to: row.email,
            subject: buildSubject(plan, cat, sd),
            html,
            provider,
          });
          await supabase.from("email_outbox").update({
            status: result.ok ? "sent" : "failed",
            provider: result.ok ? (provider ?? "ses") : null,
            provider_message_id: result.messageId ?? null,
            error: result.error ?? null,
            sent_at: result.ok ? new Date().toISOString() : null,
          }).eq("id", row.id);

          // Same delivery log the normal path writes, so email-events can join
          // provider_message_id back to a row and stamp delivered/bounced.
          if (row.digest_id) {
            await supabase.from("article_deliveries").insert({
              digest_id: row.digest_id,
              subscriber_id: row.subscriber_id ?? null,
              email: row.email,
              status: result.ok ? "sent" : "failed",
              provider_message_id: result.messageId ?? null,
              error: result.error ?? null,
            });
          }
          if (result.ok) dSent++; else dFailed++;
        } catch (e) {
          dFailed++;
          await supabase.from("email_outbox")
            .update({ status: "failed", error: String(e).slice(0, 300) })
            .eq("id", row.id);
        }
      }));
    }

    // head:true returns NO rows, so the total lives in `count`, not in `data`.
    // Reading data.length here always yielded null, which would tell a watchdog
    // "nothing left to send" forever while the queue was still full.
    const { count: remaining } = await supabase
      .from("email_outbox")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued");
    return json({
      mode: "drain",
      claimed: rows.length,
      sent: dSent,
      failed: dFailed,
      queuedRemaining: remaining ?? 0,
      done: (remaining ?? 0) === 0,
    });
  }

  // ---- PLAN: enqueue one row per recipient, send nothing ------------------
  // Enqueues the legacy `subscribers` table, which is where volume lives.
  // Account subscribers keep the in-request path below: there are only a handful
  // and each can yield two different products, so they are not the scaling
  // problem and not worth encoding into the queue yet.
  if (planOnly) {
    // ONE digest per IST day, reused on re-plan.
    //
    // The outbox unique index spans (digest_id, email), so it can only suppress
    // a duplicate WITHIN a digest. Minting a fresh digest on every call made the
    // index useless: a second plan run enqueued all 23 people again and would
    // have double-sent. On a cron that is a daily double-send, which is exactly
    // the failure the queue was built to prevent.
    //
    // digests.scheduled_key is unique, so claiming 'outbox:<IST date>' makes the
    // day's digest idempotent. A distinct prefix from the scheduled send's
    // 'newsletter:<IST date>' keeps the two from stealing each other's row.
    const istDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const outboxKey = `outbox:${istDate}`;
    let digestRow: { id: string } | null = null;

    const { data: created, error: dErr } = await supabase
      .from("digests")
      .insert({ article_ids: [], recipients: 0, scheduled_key: outboxKey })
      .select("id")
      .single();
    if (dErr && dErr.code !== "23505") return json({ error: dErr.message }, 500);
    if (created) {
      digestRow = created as { id: string };
    } else {
      // Someone already planned today; reuse that digest so the unique index
      // sees the existing rows and this run becomes a genuine no-op.
      const { data: existing, error: exErr } = await supabase
        .from("digests")
        .select("id")
        .eq("scheduled_key", outboxKey)
        .maybeSingle();
      if (exErr) return json({ error: exErr.message }, 500);
      if (!existing) return json({ error: "could not resolve today's outbox digest" }, 500);
      digestRow = existing as { id: string };
    }

    const { data: accountRows } = await supabase
      .from("newsletter_subscriptions").select("user_id").eq("status", "active");
    const uids = [...new Set((accountRows ?? []).map((r: any) => r.user_id))];
    const accountEmailSet = new Set<string>();
    if (uids.length > 0) {
      const { data: profs } = await supabase.from("profiles").select("email").in("id", uids);
      for (const p of (profs ?? []) as Array<{ email: string }>) {
        if (p.email) accountEmailSet.add(normalizeEmail(p.email));
      }
    }

    // Page through subscribers: a bare select is capped by PostgREST's max-rows,
    // which would silently enqueue only the first page and look like a success.
    const PAGE = 1000;
    let enqueued = 0;
    for (let from = 0; ; from += PAGE) {
      const { data: subs, error: sErr } = await supabase
        .from("subscribers")
        .select("id,email,full_name,plan,category")
        .eq("status", "subscribed")
        .order("id")
        .range(from, from + PAGE - 1);
      if (sErr) return json({ error: sErr.message }, 500);
      const page = (subs ?? []) as Subscriber[];
      if (page.length === 0) break;

      const rows = page
        .filter((s) => !accountEmailSet.has(normalizeEmail(s.email)))
        .map((s) => ({
          digest_id: digestRow!.id,
          subscriber_id: s.id,
          // Normalized on the way in: the unique index ON CONFLICT infers below
          // is on the raw column, so the stored value has to already be
          // lower-cased for a re-planned run to recognise the same person.
          email: normalizeEmail(s.email),
          full_name: s.full_name,
          plan: (s.plan ?? "daily-wrap").trim(),
          category: s.category,
          payload: {},
        }));
      if (rows.length > 0) {
        // The unique index on (digest_id, email) makes a retried plan run a
        // no-op instead of a double-enqueue. It must be a plain-column index:
        // PostgREST's onConflict takes column names only, so it cannot infer an
        // expression index like (digest_id, lower(email)).
        const { data: ins, error: insErr } = await supabase
          .from("email_outbox")
          .upsert(rows, { onConflict: "digest_id,email", ignoreDuplicates: true })
          .select("id");
        // Never swallow this. Discarding it meant a rejected insert still
        // returned 200 with enqueued:0 -- at 50k/day a cron planner would
        // report success every morning while queueing nobody.
        if (insErr) return json({ error: insErr.message }, 500);
        enqueued += ins?.length ?? 0;
      }
      if (page.length < PAGE) break;
    }

    return json({ mode: "plan", digestId: digestRow!.id, enqueued });
  }

  // ---- Test/recipients override: explicit recipients with independent shorts/case
  // categories. Sends real emails, logs nothing, and never marks content as sent. ----
  if (recipients.length > 0) {
    const sd = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
    let sent = 0;
    let failed = 0;
    const out: Array<Record<string, unknown>> = [];
    for (const r of recipients) {
      const email = String((r as Record<string, unknown>).email ?? "").trim();
      if (!email.includes("@")) { out.push({ email, ok: false, error: "invalid email" }); continue; }
      const plan = String((r as Record<string, unknown>).plan ?? "daily-wrap").trim();
      const shortsCategory = (r as Record<string, unknown>).shorts_category as string | null ?? null;
      const caseCategory = (r as Record<string, unknown>).case_category as string | null ?? null;
      const selection = selectFor(plan, shortsCategory, caseCategory, wrapPool, categoryPool, caseStudies);
      if ((plan === "case-only" && !selection.caseStudy) ||
        (plan !== "case-only" && selection.wrap.length === 0 && selection.shorts.length === 0 && !selection.caseStudy)) {
        out.push({ email, plan, ok: false, error: "No matching approved content available" });
        failed += 1;
        continue;
      }
      const requestedSubject = String((r as Record<string, unknown>).subject ?? "").trim();
      const subject = requestedSubject || buildSubject(plan, caseCategory ?? shortsCategory, sd);
      const html = await renderEmail({ id: "", email, full_name: (r as Record<string, unknown>).full_name as string ?? null, plan, category: null }, plan, selection);
      const result = await sendEmail({ to: email, subject, html, provider });
      if (result.ok) sent += 1; else failed += 1;
      out.push({
        email, plan, ok: result.ok, messageId: result.messageId ?? null, error: result.error ?? null,
        wrap: selection.wrap.length, shorts: selection.shorts.length, caseStudy: Boolean(selection.caseStudy)
      });
    }
    return json({ mode: "recipients", sent, failed, results: out, wrapJudged: wrapOrder.judged, wrapCandidates: wrapOrder.candidates, wrapBreaking: wrapOrder.breaking, wrapDupPairs: wrapOrder.dupPairs });
  }

  // ---- 2. Create the digest (shared by the account + legacy sends) ----
  const { data: digest, error: digestError } = await supabase
    .from("digests")
    .insert({
      article_ids: [],
      recipients: 0,
      scheduled_key: isScheduled && !forceSend
        ? `newsletter:${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())}`
        : null,
    })
    .select("id")
    .single();
  if (digestError?.code === "23505") {
    return json({ skipped: true, reason: "Newsletter already started for the current IST day." });
  }
  if (digestError) return json({ error: digestError.message }, 500);
  const digestId = digest!.id as string;

  const usedArticleIds = new Set<string>();
  const usedEditorialIds = new Set<string>();
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const planTally: Record<string, number> = {};
  const subjectDate = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const markUsed = (sel: Selection) => {
    sel.wrap.forEach((a) => usedArticleIds.add(a.id));
    sel.shorts.forEach((a) => usedArticleIds.add(a.id));
    if (sel.caseStudy) usedEditorialIds.add(sel.caseStudy.id);
  };

  // ---- 2a. ACCOUNT subscribers (website /subscribe -> newsletter_subscriptions).
  // Each product the reader picked is sent as its OWN email, honouring the row's
  // rhythm: General = daily wrap; a topic on 'daily' = that topic's case study
  // every morning; on 'weekly' = its short articles on the chosen weekday (IST);
  // on 'both' = the case study daily PLUS the weekly brief on its day. Their
  // emails are excluded from the legacy branch below so nobody is double-sent.
  // Skipped for targeted (subscriber_ids) sends, which address the legacy
  // subscribers table directly.
  const accountEmails = new Set<string>();
  if (subscriberIds.length === 0) {
    const { data: accountSubs } = await supabase
      .from("newsletter_subscriptions")
      .select("user_id,category_slug,newsletter_type,weekday,rhythm")
      .eq("status", "active");
    const subsList = (accountSubs ?? []) as Array<Record<string, any>>;
    const uids = [...new Set(subsList.map((s) => s.user_id as string))];
    const profMap: Record<string, { email: string; full_name: string | null }> = {};
    if (uids.length > 0) {
      const { data: profs } = await supabase.from("profiles").select("id,email,full_name").in("id", uids);
      for (const p of (profs ?? []) as Array<Record<string, any>>) {
        if (p.email) profMap[p.id] = { email: p.email, full_name: p.full_name ?? null };
      }
    }
    for (const p of Object.values(profMap)) accountEmails.add(normalizeEmail(p.email));
    const today = istWeekday();
    const jobs = subsList.filter((s) => profMap[s.user_id as string]);
    for (let i = 0; i < jobs.length; i += 5) {
      const batch = jobs.slice(i, i + 5);
      const results = await Promise.all(batch.map(async (s) => {
        const prof = profMap[s.user_id as string];
        // rhythm 'both' can yield two products (daily case study + weekly brief).
        const builts = buildAccountEmails(s, today, subjectDate, wrapPool, categoryPool, caseStudies);
        if (builts.length === 0) { skipped += 1; return []; }
        const outcomes: boolean[] = [];
        for (const built of builts) {
          const html = await renderShell(prof.full_name, prof.email, built.intro, built.sections);
          const result = await sendEmail({ to: testEmail ?? prof.email, subject: built.subject, html });
          await supabase.from("article_deliveries").insert({
            digest_id: digestId, subscriber_id: null, email: testEmail ?? prof.email,
            status: result.ok ? "sent" : "failed", provider_message_id: result.messageId ?? null, error: result.error ?? null,
          });
          if (result.ok && !testEmail) markUsed(built.selection);
          if (result.ok) planTally[built.tally] = (planTally[built.tally] ?? 0) + 1;
          outcomes.push(result.ok);
        }
        return outcomes;
      }));
      const flat = results.flat();
      sent += flat.filter((r) => r === true).length;
      failed += flat.filter((r) => r === false).length;
    }
  }

  // ---- 2b. LEGACY subscribers (subscribers table) minus anyone already handled
  // via their website account.
  let subQuery = supabase
    .from("subscribers")
    .select("id,email,full_name,plan,category")
    .eq("status", "subscribed");
  if (subscriberIds.length > 0) subQuery = subQuery.in("id", subscriberIds);
  const { data: subs, error: subError } = await subQuery;
  if (subError) return json({ error: subError.message }, 500);
  const subscribers = ((subs ?? []) as Subscriber[])
    .filter((s) => subscriberIds.length > 0 || !accountEmails.has(normalizeEmail(s.email)));

  // Concurrency per batch. Measured 2026-08-15: a batch takes ~855ms
  // regardless of size, so throughput = batchSize / 0.855s. At 5 that is
  // ~5.8 emails/sec, which puts a 150s edge-function budget at ~850
  // recipients. 10 gives ~11.7/sec (ceiling ~1700) and stays clear of the
  // default SES rate limit of 14/sec. Override with SEND_BATCH_SIZE if the
  // account's SES quota is raised.
  const batchSize = (() => {
    const v = Number(Deno.env.get("SEND_BATCH_SIZE"));
    return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 25) : 10;
  })();
  for (let i = 0; i < subscribers.length; i += batchSize) {
    const batch = subscribers.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (sub) => {
      const plan = (sub.plan ?? "daily-wrap").trim();
      const selection = selectFor(plan, sub.category, sub.category, wrapPool, categoryPool, caseStudies);
      if (selection.wrap.length === 0 && selection.shorts.length === 0 && !selection.caseStudy) {
        skipped += 1;
        return null;
      }
      const subject = buildSubject(plan, sub.category, subjectDate);
      const html = await renderEmail(sub, plan, selection);
      const result = await sendEmail({ to: testEmail ?? sub.email, subject, html });
      await supabase.from("article_deliveries").insert({
        digest_id: digestId, subscriber_id: sub.id, email: testEmail ?? sub.email,
        status: result.ok ? "sent" : "failed", provider_message_id: result.messageId ?? null, error: result.error ?? null,
      });
      if (result.ok && !testEmail) markUsed(selection);
      if (result.ok) planTally[plan] = (planTally[plan] ?? 0) + 1;
      return result.ok;
    }));
    sent += results.filter((r) => r === true).length;
    failed += results.filter((r) => r === false).length;
  }

  // ---- 3. Mark used content as sent (skip when this was a test) ----
  // If even one recipient failed, leave the approved content available for a
  // controlled retry instead of consuming it globally.
  if (!testEmail && failed === 0) {
    if (usedArticleIds.size > 0) {
      await supabase.from("articles")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .in("id", [...usedArticleIds]);
    }
    if (usedEditorialIds.size > 0) {
      await supabase.from("editorial_drafts")
        .update({ status: "published", updated_at: new Date().toISOString() })
        .in("id", [...usedEditorialIds]);
    }
  }

  await supabase.from("digests")
    .update({ article_ids: [...usedArticleIds], recipients: sent, sent, failed })
    .eq("id", digestId);

  return json({ digestId, sent, failed, skipped, accountSubscribers: accountEmails.size, plans: planTally, test: Boolean(testEmail), wrapJudged: wrapOrder.judged, wrapCandidates: wrapOrder.candidates, wrapBreaking: wrapOrder.breaking, wrapDupPairs: wrapOrder.dupPairs });
});

function istWeekday(): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "long" })
    .format(new Date())
    .toLowerCase();
}

function normalizeEmail(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}

// Editorial ordering prioritises breaking stories, but each outgoing email
// must retain room for the rest of the day's important coverage.
function limitBreakingStories(pool: Article[]): Article[] {
  let breakingCount = 0;
  return pool.filter((article) => {
    if (!article.is_breaking) return true;
    breakingCount += 1;
    return breakingCount <= MAX_EMAIL_BREAKING;
  });
}

const SLUG_TO_CATEGORY: Record<string, string> = {
  "real-estate": "Real Estate",
  "automobile": "Automobile",
  "health-wellness": "Health & Wellness",
  "tech-ai": "Tech & AI",
  "markets-startups": "Markets & Startups",
};

type BuiltEmail = { subject: string; intro: string; sections: string; selection: Selection; tally: string };

// Default rhythm for rows written before the daily/weekly toggle existed:
// General was daily, category shorts were weekly.
function defaultRhythm(type: string): string {
  return type === "category_small_articles" ? "weekly" : "daily";
}

// One newsletter_subscriptions row -> up to TWO product emails.
//
// Rhythm matrix (matches the website subscribe drawer):
//   General (news_rhythm) -> DAILY only: the ten-story daily wrap.
//   Any topic category    -> reader picks Daily, Weekly, or Both:
//     - Daily  = that topic's case study, every morning.
//     - Weekly = that topic's short articles, on the chosen weekday (IST).
//     - Both   = the case study every morning PLUS the weekly brief on its day.
function buildAccountEmails(
  s: Record<string, any>,
  today: string,
  subjectDate: string,
  wrapPool: Article[],
  categoryPool: Record<string, Article[]>,
  caseStudies: Record<string, CaseStudy>,
): BuiltEmail[] {
  const type = String(s.newsletter_type ?? "");
  const rhythm = String(s.rhythm ?? "").toLowerCase() || defaultRhythm(type);

  // General wrap â€” daily only, ten stories.
  if (type === "news_rhythm") {
    const wrap = wrapPool.slice(0, WRAP_COUNT);
    if (wrap.length === 0) return [];
    const selection: Selection = { wrap, shorts: [], caseStudy: null, shortsCategory: null };
    return [{
      // One fixed subject line every day â€” no "Breaking:" variant.
      subject: `${subjectDate} - Your Dailymattr Wrap is here!`,
      intro: "Here are 5 stories that deserve your attention. Grab your coffee - and we'll get you informed.",
      sections: renderWrapSections(wrap),
      selection,
      tally: "daily-headlines",
    }];
  }

  // Every topic category (Real Estate, Automobile, Health & Wellness, Tech & AI, Markets & Startups).
  const name = SLUG_TO_CATEGORY[String(s.category_slug ?? "")];
  if (!name) return [];

  const out: BuiltEmail[] = [];

  // Daily case study (rhythm daily or both).
  if (rhythm === "daily" || rhythm === "both") {
    const cs = caseStudies[name] ?? null;
    if (cs) {
      const selection: Selection = { wrap: [], shorts: [], caseStudy: cs, shortsCategory: null };
      out.push({
        subject: `${subjectDate} - Dailymattr ${name} Case Study`,
        intro: `Today's ${escapeHtml(name)} case study - one story worth understanding properly.`,
        sections: renderCaseStudy(cs),
        selection,
        tally: `daily-${name}`,
      });
    }
  }

  // Weekly shorts brief on the chosen weekday (rhythm weekly or both).
  if ((rhythm === "weekly" || rhythm === "both") && String(s.weekday ?? "") === today) {
    const shorts = (categoryPool[name] ?? []).slice(0, CATEGORY_SPLIT);
    if (shorts.length > 0) {
      const selection: Selection = { wrap: [], shorts, caseStudy: null, shortsCategory: name };
      out.push({
        subject: `${subjectDate} - Dailymattr ${name} Weekly Briefing`,
        intro: `Your weekly ${escapeHtml(name)} briefing: ${shorts.length} updates worth knowing.`,
        sections: renderSection(`${name} Briefs`, "#b45309", shorts),
        selection,
        tally: `weekly-${name}`,
      });
    }
  }

  return out;
}

// ---------- content selection ----------

// Every topic's daily case study now comes from editorial_drafts (the
// corporate_cases pipeline is retired along with the Corporate Cases category).
async function loadCaseStudies(supabase: ReturnType<typeof createClient>, istStart: string, istEnd: string, includeActivePool = false): Promise<Record<string, CaseStudy>> {
  const map: Record<string, CaseStudy> = {};

  let query = supabase
    .from("editorial_drafts")
    .select("id,topic_slug,topic_name,headline,summary,detail,primary_source_url,primary_source_title,generated_at,updated_at")
    .eq("status", "approved")
    .order("generated_at", { ascending: false })
    .limit(50);
  if (!includeActivePool) {
    query = query.gte("updated_at", istStart).lt("updated_at", istEnd);
  }
  const { data: drafts } = await query;
  for (const d of drafts ?? []) {
    const category = Object.keys(CATEGORY_TO_SLUG).find((cat) => CATEGORY_TO_SLUG[cat] === d.topic_slug);
    if (!category || map[category]) continue; // keep the most recent per category
    map[category] = {
      kind: "editorial",
      id: d.id,
      category,
      headline: d.headline ?? d.topic_name ?? "",
      summary: d.summary ?? "",
      detail: d.detail ?? "",
      source: d.primary_source_title ?? null,
      source_url: d.primary_source_url ?? null,
    };
  }

  return map;
}

type Selection = { wrap: Article[]; shorts: Article[]; caseStudy: CaseStudy | null; shortsCategory: string | null };

// shortsCategory and caseCategory are usually the same (the subscriber's one category),
// but the test/recipients path may set them independently.
function selectFor(
  plan: string,
  shortsCategory: string | null,
  caseCategory: string | null,
  wrapPool: Article[],
  categoryPool: Record<string, Article[]>,
  caseStudies: Record<string, CaseStudy>,
): Selection {
  const sCat = shortsCategory && CATEGORIES.includes(shortsCategory) ? shortsCategory : null;
  const cCat = caseCategory && CATEGORIES.includes(caseCategory) ? caseCategory : null;
  const catShorts = sCat ? (categoryPool[sCat] ?? []) : [];
  const caseStudy = cCat ? (caseStudies[cCat] ?? null) : null;

  switch (plan) {
    case "category-case":
      return { wrap: [], shorts: catShorts.slice(0, CATEGORY_CASE_SHORTS), caseStudy, shortsCategory: sCat };
    case "wrap-category":
      return { wrap: wrapPool.slice(0, WRAP_SPLIT), shorts: catShorts.slice(0, CATEGORY_SPLIT), caseStudy: null, shortsCategory: sCat };
    case "case-only":
      return { wrap: [], shorts: [], caseStudy, shortsCategory: null };
    case "daily-wrap":
    default:
      return { wrap: wrapPool.slice(0, WRAP_COUNT), shorts: [], caseStudy: null, shortsCategory: null };
  }
}

function buildSubject(plan: string, category: string | null, subjectDate: string): string {
  if (plan === "case-only" && category) return `${subjectDate} - Dailymattr ${category} Case Study`;
  if (plan === "category-case" && category) return `${subjectDate} - Your Dailymattr ${category} brief`;
  if (plan === "wrap-category" && category) return `${subjectDate} - Dailymattr Daily Wrap + ${category}`;
  // Daily wrap â€” same fixed subject as the account path (buildAccountEmails).
  return `${subjectDate} - Your Dailymattr Wrap is here!`;
}

// ---------- rendering ----------

function escapeHtml(v = "") {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderLabelBar(text: string, bg: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 22px"><tr><td style="background:${bg};color:#ffffff;padding:8px 24px;font-size:17px;line-height:1.25;font-weight:800;letter-spacing:-0.02em;font-family:'Roboto Serif',Georgia,serif">${escapeHtml(text)}</td></tr></table>`;
}

function renderTopMeta(): string {
  const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff"><tr><td style="padding:8px 24px;color:#3979ff;font:700 12px/22px Roboto,Arial,sans-serif;letter-spacing:.02em">From Team Dailymattr</td><td style="padding:8px 24px;color:#3979ff;font:700 12px/22px Roboto,Arial,sans-serif;text-align:right">${today}</td></tr></table>`;
}

function renderHero(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#3979ff"><tr><td><img src="${BANNER_URL}" alt="Dailymattr - Stories that matter" width="1280" style="display:block;width:100%;height:auto;border:0" /></td></tr></table>`;
}

function renderLegacyFooterBrand(): string {
  return `<div style="text-align:center;padding:24px 20px 8px;background:#fff"><div style="margin:0 0 10px;color:#3979ff;font:700 24px/1 'Roboto Serif',Georgia,serif">Dailymattr<sup style="font-size:10px">Â®</sup></div><p style="margin:0 0 8px;color:#70707c;font:16px/1.5 Roboto,Arial,sans-serif">Curated news, summarized daily.<br>You're receiving this because you subscribed to <span style="color:#3979ff">Dailymattr</span></p><p style="margin:0;color:#70707c;font:16px/1.5 Roboto,Arial,sans-serif">Can be <u>forwarded</u> to others.</p></div>`;
}

function renderLegacyFooter(subscribeUrl: string, twitterUrl: string, linkedinUrl: string, privacyFooter: string): string {
  const icon = (href: string, label: string) => `<a href="${href}" style="display:inline-block;width:28px;height:28px;line-height:28px;margin-right:10px;border-radius:50%;background:#000;color:#fff;text-align:center;text-decoration:none;font:700 14px/28px Arial,sans-serif">${label}</a>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:28px"><tr><td style="padding:18px 28px 14px;background:#fff"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td>${icon("https://www.instagram.com/dailymattr", "?")}${icon(twitterUrl, "X")}${icon(linkedinUrl, "in")}</td><td style="text-align:right"><a href="${subscribeUrl}" style="display:inline-block;background:#3979ff;color:#fff;border-radius:24px;padding:12px 20px;text-decoration:none;font:700 15px/1 Roboto,Arial,sans-serif">Subscribe&nbsp; ?</a></td></tr></table></td></tr><tr><td style="background:#3979ff;color:#fff;padding:16px 28px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="font:700 15px/1.2 Roboto,Arial,sans-serif">Read from anywhere</td><td style="text-align:right"><a href="#" style="display:inline-block;background:#3979ff;border:1px solid #333;border-radius:20px;color:#fff;padding:9px 14px;text-decoration:none;font:600 11px/1 Roboto,Arial,sans-serif">?&nbsp; Google Play</a>&nbsp; <a href="#" style="display:inline-block;background:#3979ff;border:1px solid #333;border-radius:20px;color:#fff;padding:9px 14px;text-decoration:none;font:600 11px/1 Roboto,Arial,sans-serif">?&nbsp; App Store</a></td></tr></table></td></tr></table>${privacyFooter}`;
}

function normalizeStoreLinks(html: string): string {
  return html.replace('href="#"', 'href="https://play.google.com/store"').replace('href="#"', 'href="https://www.apple.com/app-store/"');
}

function renderFooterBrand(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff"><tr><td align="center" style="padding:24px 20px 16px;text-align:center"><img src="${FOOTER_LOGO_URL}" alt="dailymattr" width="210" align="center" style="display:block;width:210px;max-width:100%;height:auto;margin:0 auto 12px;border:0" /><p style="margin:0 0 14px;color:#70707c;font:16px/1.5 Roboto,Arial,sans-serif">Can be forwarded to others.</p><a href="https://longmattr.com/general" style="display:inline-block;background:#3979ff;color:#ffffff;border-radius:22px;padding:10px 18px;text-decoration:none;font:700 14px/1 Roboto,Arial,sans-serif">More news</a></td></tr></table>`;
}

function renderFooter(subscribeUrl: string, twitterUrl: string, linkedinUrl: string, privacyFooter: string): string {
  const icon = (href: string, imageUrl: string, alt: string, label: string) => `<a href="${href}" style="display:inline-block;width:28px;height:28px;line-height:28px;margin:0 5px;border-radius:50%;background:#000;color:#fff;text-align:center;text-decoration:none;font:700 14px/28px Arial,sans-serif">${imageUrl ? `<img src="${imageUrl}" alt="${alt}" width="15" height="15" style="display:inline-block;vertical-align:middle;border:0" />` : label}</a>`;
  const storeButton = (href: string, imageUrl: string, label: string) => `<a href="${href}" style="display:inline-block;background:#3979ff;border:1px solid #1f3155;border-radius:20px;color:#fff;padding:9px 14px;text-decoration:none;font:600 11px/1 Roboto,Arial,sans-serif"><img src="${imageUrl}" alt="" width="14" height="14" style="display:inline-block;vertical-align:middle;margin-right:5px;border:0" />${label}</a>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:18px"><tr><td align="center" style="padding:16px 20px 18px;background:#fff;text-align:center">${icon(INSTAGRAM_URL, INSTAGRAM_ICON_URL, "Instagram", "Instagram")}${icon(twitterUrl, "", "X", "X")}${icon(linkedinUrl, "", "LinkedIn", "in")}</td></tr><tr><td align="center" style="background:#3979ff;color:#fff;padding:16px 20px;text-align:center"><div style="font:700 15px/1.2 Roboto,Arial,sans-serif;margin:0 0 12px">Read from anywhere</div>${storeButton(PLAY_STORE_URL, GOOGLE_PLAY_ICON_URL, "Google Play")}&nbsp;${storeButton("https://www.apple.com/app-store/", APP_STORE_ICON_URL, "App Store")}</td></tr></table>${privacyFooter}`;
}

function renderLegacyDesktopFooter(subscribeUrl: string, twitterUrl: string, linkedinUrl: string, privacyFooter: string): string {
  const icon = (href: string, imageUrl: string, alt: string, label: string) => `<a href="${href}" style="display:inline-block;width:28px;height:28px;line-height:28px;margin-right:10px;border-radius:50%;background:#000;color:#fff;text-align:center;text-decoration:none;font:700 14px/28px Arial,sans-serif">${imageUrl ? `<img src="${imageUrl}" alt="${alt}" width="15" height="15" style="display:inline-block;vertical-align:middle;border:0" />` : label}</a>`;
  const storeButton = (href: string, imageUrl: string, label: string) => `<a href="${href}" style="display:inline-block;background:#3979ff;border:1px solid #1f3155;border-radius:20px;color:#fff;padding:9px 14px;text-decoration:none;font:600 11px/1 Roboto,Arial,sans-serif"><img src="${imageUrl}" alt="" width="14" height="14" style="display:inline-block;vertical-align:middle;margin-right:5px;border:0" />${label}</a>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:28px"><tr><td style="padding:18px 28px 14px;background:#fff"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td>${icon("https://www.instagram.com/dailymattr", INSTAGRAM_ICON_URL, "Instagram", "Instagram")}${icon(twitterUrl, "", "X", "X")}${icon(linkedinUrl, "", "LinkedIn", "in")}</td><td style="text-align:right"><a href="${subscribeUrl}" style="display:inline-block;background:#3979ff;color:#fff;border-radius:24px;padding:12px 20px;text-decoration:none;font:700 15px/1 Roboto,Arial,sans-serif">Subscribe&nbsp;&rarr;</a></td></tr></table></td></tr><tr><td style="background:#3979ff;color:#fff;padding:16px 28px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="font:700 15px/1.2 Roboto,Arial,sans-serif">Read from anywhere</td><td style="text-align:right">${storeButton("https://play.google.com/store", GOOGLE_PLAY_ICON_URL, "Google Play")}&nbsp;${storeButton("https://www.apple.com/app-store/", APP_STORE_ICON_URL, "App Store")}</td></tr></table></td></tr></table>${privacyFooter}`;
}

// Fact-score badge: only shown when the AI fact check scored the article well
// (>= 65). Weak/unscored articles carry no badge â€” an email should never
// advertise its own doubts; low scores are for the QA dashboard to catch.
function renderFactBadge(a: Article): string {
  if (a.fact_score == null || a.fact_score < 65) return "";
  const verified = a.fact_label === "verified";
  const color = verified ? "#0f9d69" : "#8a6d00";
  const n = Number(a.fact_notes?.source_count) || (Array.isArray(a.fact_notes?.sources) ? a.fact_notes!.sources!.length : 0);
  const base = verified ? `Fact-checked ${Math.round(a.fact_score)}/100` : `Fact score ${Math.round(a.fact_score)}/100`;
  const text = n > 1 ? `${base} Â· ${n} sources` : base;
  return `<div style="display:inline-block;border:2px solid ${color};color:${color};font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;padding:1px 8px;border-radius:999px;margin:0 0 8px;font-family:Roboto,Arial,sans-serif">${escapeHtml(text)}</div>`;
}

function renderSection(label: string, bg: string, articles: Article[]): string {
  if (articles.length === 0) return "";
  return `
    ${renderLabelBar(label, bg)}
    <div style="margin-bottom:22px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${renderItemsReal(articles)}</table>
    </div>`;
}

function renderBreakingBadge(article: Article): string {
  if (!article.is_breaking) return "";
  return `<span style="display:inline-block;vertical-align:middle;margin:0 0 8px;padding:2px 8px;border-radius:999px;background:#c2221e;color:#ffffff;font-size:10px;line-height:1.2;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;font-family:Roboto,Arial,sans-serif">Breaking</span>`;
}

function renderItemsReal(articles: Article[]): string {
  return articles.map((article) => {
    const headline = (article.edited_title || article.title || "").trim();
    const text = (article.edited_summary || article.summary || "").trim();
    const category = (article.category || article.topic || "General").replaceAll("-", " ");
    return `<tr><td style="padding:0 0 16px"><div style="background:#f5f5f5;border:1px solid #e1e1e1;border-radius:10px;padding:16px 12px 14px">
      ${renderBreakingBadge(article)}
      <h2 style="font-size:16px;line-height:1.32;margin:0 0 10px;color:#222222;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${escapeHtml(headline)}</h2>
      <p style="font-size:12px;line-height:1.2;margin:0 0 14px;color:#666666;font-family:Roboto,Arial,sans-serif">${escapeHtml(category)}</p>
      <p style="font-size:13px;line-height:1.55;color:#686868;margin:0 0 12px;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${escapeHtml(text)}</p>
      ${renderSourceMeta(article)}
    </div></td></tr>`;
  }).join("");
}

// Daily-wrap renderer: ALWAYS one "Quick Hits. Daily Wrap" section â€” the email
// never carries a red BREAKING banner. Breaking stories are still front-loaded
// in the pool (is_breaking ordering above), so the hottest story leads the
// list; it just isn't labelled as breaking.
function renderWrapSections(wrap: Article[]): string {
  return renderSection("Quick Hits. Daily Wrap", "#111111", wrap);
}

function renderCaseStudy(cs: CaseStudy): string {
  const paragraphs = (cs.detail || cs.summary || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="font-size:15px;line-height:1.74;color:#2f2f39;margin:0 0 12px;font-family:Roboto,Arial,sans-serif">${escapeHtml(p)}</p>`)
    .join("");
  const sourceLine = cs.source_url
    ? `<p style="font-size:13px;line-height:1.6;color:#111111;margin:8px 0 0;font-family:Roboto,Arial,sans-serif"><a href="${escapeHtml(cs.source_url)}" style="color:#111111;text-decoration:underline">Read the full source${cs.source ? ` - ${escapeHtml(cs.source)}` : ""}</a></p>`
    : "";
  return `
    ${renderLabelBar(`Case Study - ${cs.category}`, "#0f9d69")}
    <div style="margin-bottom:22px">
      <div style="background:#ffffff;border:1px solid #111111;border-radius:12px;padding:22px 22px 18px">
        <h2 style="font-size:21px;line-height:1.25;margin:0 0 12px;color:#191919;font-weight:800;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${escapeHtml(cs.headline)}</h2>
        ${cs.summary ? `<p style="font-size:16px;line-height:1.7;color:#191919;font-weight:500;margin:0 0 14px;font-family:Roboto,Arial,sans-serif">${escapeHtml(cs.summary)}</p>` : ""}
        ${paragraphs}
        ${sourceLine}
      </div>
    </div>`;
}

async function renderEmail(sub: Subscriber, plan: string, selection: Selection): Promise<string> {
  let sections = "";
  if (plan === "wrap-category") {
    sections += renderWrapSections(selection.wrap);
    sections += renderSection(`${selection.shortsCategory ?? "Category"} Briefs`, "#b45309", selection.shorts);
  } else if (plan === "category-case") {
    sections += renderSection(`${selection.shortsCategory ?? "Category"} Briefs`, "#b45309", selection.shorts);
    if (selection.caseStudy) sections += renderCaseStudy(selection.caseStudy);
  } else if (plan === "case-only") {
    if (selection.caseStudy) sections += renderCaseStudy(selection.caseStudy);
  } else {
    sections += renderWrapSections(selection.wrap);
  }
  return renderShell(sub.full_name, sub.email, introFor(plan, selection), sections);
}

function renderSourceMeta(a: Article): string {
  const sources = Array.isArray(a.fact_notes?.sources)
    ? a.fact_notes!.sources!.filter((source) => source?.url && source?.source).slice(0, 5)
    : [];
  if (sources.length === 0 && a.url) sources.push({ source: a.source || "Read source", url: a.url });
  return sources
    .map((source) => `<a href="${escapeHtml(source.url)}" style="color:#555555;text-decoration:none">${escapeHtml(source.source)}</a>`)
    .join(`<span aria-hidden="true" style="color:#777777">&nbsp;|&nbsp;</span>`);
}

async function renderShell(fullName: string | null, email: string, intro: string, sections: string): Promise<string> {
  const greeting = fullName ? `Hi ${escapeHtml(fullName)},` : "Hi there,";
  const shareUrl = SITE_URL ? `${SITE_URL}/subscribe.html?utm_source=email&utm_medium=share&utm_campaign=subscribe` : "";
  const shareMessage = "Click here to subscribe to Dailymattr:";
  const twitterUrl = X_URL;
  const linkedinUrl = LINKEDIN_URL;
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${shareMessage} ${shareUrl}`.trim())}`;
  const privacyFooter = await renderPrivacyFooter(email);

  return `
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;800&family=Roboto+Serif:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <div style="margin:0;background:#ffffff;padding:0;font-family:Roboto,Arial,sans-serif;color:#191919">
    <div style="max-width:640px;margin:0 auto">
      ${renderTopMeta()}
      ${renderHero()}
      <div style="background:#ffffff;padding:24px;margin:0 0 22px;border-bottom:1px solid #d1d1d1">
        <p style="margin:0 0 12px;color:#191919;font-size:18px;line-height:1.3;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${greeting}</p>
        <p style="margin:0;color:#111111;font-size:16px;line-height:1.55;font-family:Roboto,Arial,sans-serif">${intro}</p>
      </div>

      ${sections}

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="display:none;margin-top:4px;margin-bottom:20px">
        <tr><td style="text-align:center;padding:10px 20px 14px">
          <div style="margin:0 auto 8px;color:#111111;font:700 24px/1 'Roboto Serif',Georgia,serif">Dailymattr<sup style="font-size:10px">Â®</sup></div>
          <p style="margin:0 0 10px;color:#9a9ab0;font-size:12px;line-height:1.5;font-family:Roboto,Arial,sans-serif">Curated news, summarized daily.<br>You're receiving this because you subscribed to Dailymattr.</p>
          <div style="text-align:center">
            <a href="${twitterUrl}" style="display:inline-block;margin:0 6px;color:#111111;text-decoration:none;font-size:12px;font-weight:700">X</a>
            <a href="${linkedinUrl}" style="display:inline-block;margin:0 6px;color:#111111;text-decoration:none;font-size:12px;font-weight:700">LinkedIn</a>
            <a href="${whatsappUrl}" style="display:inline-block;margin:0 6px;color:#111111;text-decoration:none;font-size:12px;font-weight:700">WhatsApp</a>
          </div>
          ${privacyFooter}
        </td></tr>
      </table>
      ${renderFooterBrand()}${normalizeStoreLinks(renderFooter("https://longmattr.com/", twitterUrl, linkedinUrl, privacyFooter))}
    </div>
  </div>`;
}

function introFor(plan: string, selection: Selection): string {
  const cat = selection.shortsCategory ?? selection.caseStudy?.category ?? "your category";
  switch (plan) {
    case "category-case":
      return `Your ${escapeHtml(cat)} briefing: ${selection.shorts.length} quick updates${selection.caseStudy ? " plus today's deep-dive case study" : ""}. You'll be caught up Dailymattr!`;
    case "wrap-category":
      return `The day's biggest stories plus ${selection.shorts.length} fresh ${escapeHtml(cat)} updates, minus the noise. Grab your coffee.`;
    case "case-only":
      return `Today's ${escapeHtml(cat)} case study - one story worth understanding properly.`;
    default:
      return "Here are 5 stories that deserve your attention. Grab your coffee - and we'll get you informed.";
  }
}
