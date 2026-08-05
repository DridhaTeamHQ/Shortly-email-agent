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

const BANNER_URL =
  Deno.env.get("SHORTLY_BANNER_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/figma-email-banner.png";
const FOOTER_LOGO_URL =
  Deno.env.get("SHORTLY_FOOTER_LOGO_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/footer-logo.png";
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
  }

  // A test address is a single-recipient override. Never route it through the
  // normal subscriber loops, which would send one copy per subscriber.
  if (testEmail && recipients.length === 0) {
    recipients = [{ email: testEmail, plan: "daily-wrap" }];
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
    .select("id,title,edited_title,url,summary,edited_summary,source,topic,category,rank_score,prominence,fact_score,fact_label,fact_notes,scraped_at,reviewed_at,breaking_flag")
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
  const wrapOrder = await buildWrapOrder(wrapPool, {
    apiKey: Deno.env.get("OPENAI_API_KEY") ?? undefined,
    model: Deno.env.get("SUMMARIZE_MODEL") ?? "gpt-4o-mini",
    slots: WRAP_COUNT,
    flagByUrl,
  });
  wrapPool = wrapOrder.pool as Article[];

  // Explicit one-recipient tests may intentionally use an approved case from
  // the active pool even when it was approved before today's scrape window.
  const caseStudies = await loadCaseStudies(supabase, istStart, istEnd, recipients.length > 0);

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
    return json({ mode: "recipients", sent, failed, results: out });
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

  const batchSize = 5;
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

  return json({ digestId, sent, failed, skipped, accountSubscribers: accountEmails.size, plans: planTally, test: Boolean(testEmail) });
});

function istWeekday(): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "long" })
    .format(new Date())
    .toLowerCase();
}

function normalizeEmail(email: string): string {
  return String(email ?? "").trim().toLowerCase();
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
      subject: `${subjectDate} - Your daily wrap is here`,
      intro: `Here are today's ${wrap.length} biggest stories, minus the noise. You'll be caught up Dailymattr!`,
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
  return `${subjectDate} - Your daily wrap is here`;
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
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#3979ff"><tr><td style="padding:8px 24px;color:#ffffff;font:12px/22px Roboto,Arial,sans-serif;letter-spacing:.02em">From the Dailymattr Team</td><td style="padding:8px 24px;color:#ffffff;font:12px/22px Roboto,Arial,sans-serif;text-align:right">${today}</td></tr></table>`;
}

function renderHero(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#3979ff url('${BANNER_URL}') center/cover no-repeat"><tr><td style="background:rgba(0,0,0,.68);padding:36px 24px 40px;text-align:center;color:#ffffff"><div style="font:700 24px/1 'Roboto Serif',Georgia,serif;margin-bottom:18px">Dailymattr<sup style="font-size:10px">Â®</sup></div><div style="font:900 54px/.95 Georgia,'Times New Roman',serif;letter-spacing:-.04em">DAILYMATTR</div><div style="margin-top:14px;font:700 12px/1.2 Roboto,Arial,sans-serif;letter-spacing:.28em;text-transform:uppercase">Stories that matter</div></td></tr></table>`;
}

function renderFooterBrand(): string {
  return `<div style="text-align:center;padding:24px 20px 8px;background:#fff"><div style="margin:0 0 10px;color:#3979ff;font:700 24px/1 'Roboto Serif',Georgia,serif">Dailymattr<sup style="font-size:10px">Â®</sup></div><p style="margin:0 0 8px;color:#70707c;font:16px/1.5 Roboto,Arial,sans-serif">Curated news, summarized daily.<br>You're receiving this because you subscribed to <span style="color:#3979ff">Dailymattr</span></p><p style="margin:0;color:#70707c;font:16px/1.5 Roboto,Arial,sans-serif">Can be <u>forwarded</u> to others.</p></div>`;
}

function renderFooter(subscribeUrl: string, twitterUrl: string, linkedinUrl: string, privacyFooter: string): string {
  const icon = (href: string, label: string) => `<a href="${href}" style="display:inline-block;width:28px;height:28px;line-height:28px;margin-right:10px;border-radius:50%;background:#000;color:#fff;text-align:center;text-decoration:none;font:700 14px/28px Arial,sans-serif">${label}</a>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:28px"><tr><td style="padding:18px 28px 14px;background:#fff"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td>${icon("https://www.instagram.com/dailymattr", "?")}${icon(twitterUrl, "X")}${icon(linkedinUrl, "in")}</td><td style="text-align:right"><a href="${subscribeUrl}" style="display:inline-block;background:#3979ff;color:#fff;border-radius:24px;padding:12px 20px;text-decoration:none;font:700 15px/1 Roboto,Arial,sans-serif">Subscribe&nbsp; ?</a></td></tr></table></td></tr><tr><td style="background:#3979ff;color:#fff;padding:16px 28px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="font:700 15px/1.2 Roboto,Arial,sans-serif">Read from anywhere</td><td style="text-align:right"><a href="#" style="display:inline-block;background:#3979ff;border:1px solid #333;border-radius:20px;color:#fff;padding:9px 14px;text-decoration:none;font:600 11px/1 Roboto,Arial,sans-serif">?&nbsp; Google Play</a>&nbsp; <a href="#" style="display:inline-block;background:#3979ff;border:1px solid #333;border-radius:20px;color:#fff;padding:9px 14px;text-decoration:none;font:600 11px/1 Roboto,Arial,sans-serif">?&nbsp; App Store</a></td></tr></table></td></tr></table>${privacyFooter}`;
}

function normalizeStoreLinks(html: string): string {
  return html.replace('href="#"', 'href="https://play.google.com/store"').replace('href="#"', 'href="https://www.apple.com/app-store/"');
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
  return sources.map((source) => `<a href="${escapeHtml(source.url)}" style="color:#555555;text-decoration:none;margin-right:8px">${escapeHtml(source.source)}</a>`).join("");
}

async function renderShell(fullName: string | null, email: string, intro: string, sections: string): Promise<string> {
  const greeting = fullName ? `Hi ${escapeHtml(fullName)},` : "Hi there,";
  const shareUrl = SITE_URL ? `${SITE_URL}/subscribe.html?utm_source=email&utm_medium=share&utm_campaign=subscribe` : "";
  const shareMessage = "Click here to subscribe to Dailymattr:";
  const twitterUrl = shareUrl
    ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}&url=${encodeURIComponent(shareUrl)}`
    : `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}`;
  const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl || BANNER_URL)}`;
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
      return `Here are ${selection.wrap.length} things that deserve your attention. The biggest stories, minus the noise. Grab your coffee &mdash; you'll be caught up Dailymattr!`;
  }
}
