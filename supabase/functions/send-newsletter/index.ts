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
  scraped_at: string;
  reviewed_at: string | null;
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

const WRAP_COUNT = 10;
const WRAP_SPLIT = 5;
const CATEGORY_SPLIT = 5;
const CATEGORY_CASE_SHORTS = 5;

const BANNER_URL =
  Deno.env.get("SHORTLY_BANNER_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/email-banner.jpg";
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

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  let subscriberIds: string[] = [];
  let isScheduled = false;
  let forceSend = false;
  let testEmail: string | null = null;
  let recipients: Array<Record<string, unknown>> = [];
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    subscriberIds = Array.isArray(body?.subscriber_ids)
      ? body.subscriber_ids.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    isScheduled = body?.scheduled === true;
    forceSend = body?.force === true;
    testEmail = typeof body?.test_email === "string" && body.test_email.includes("@") ? body.test_email : null;
    recipients = Array.isArray(body?.recipients) ? body.recipients : [];
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
    .select("id,title,edited_title,url,summary,edited_summary,source,topic,category,rank_score,scraped_at,reviewed_at")
    .eq("status", "approved")
    .gte("reviewed_at", istStart)
    .lt("reviewed_at", istEnd)
    .order("scraped_at", { ascending: false })
    .order("rank_score", { ascending: false })
    .limit(500);
  if (articlesError) return json({ error: articlesError.message }, 500);

  const wrapPool: Article[] = [];
  const categoryPool: Record<string, Article[]> = {};
  for (const cat of CATEGORIES) categoryPool[cat] = [];
  for (const a of (approvedArticles ?? []) as Article[]) {
    if (a.category && categoryPool[a.category]) categoryPool[a.category].push(a);
    else if (!a.category) wrapPool.push(a);
  }

  const caseStudies = await loadCaseStudies(supabase, istStart, istEnd);

  // ---- Test/recipients override: explicit recipients with independent shorts/case
  // categories. Sends real emails, logs nothing, and never marks content as sent. ----
  if (recipients.length > 0) {
    const sd = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" });
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
      const subject = buildSubject(plan, caseCategory ?? shortsCategory, sd);
      const html = renderEmail({ id: "", email, full_name: (r as Record<string, unknown>).full_name as string ?? null, plan, category: null }, plan, selection);
      const result = await sendEmail({ to: email, subject, html });
      if (result.ok) sent += 1; else failed += 1;
      out.push({
        email, plan, ok: result.ok, error: result.error ?? null,
        wrap: selection.wrap.length, shorts: selection.shorts.length, caseStudy: Boolean(selection.caseStudy)
      });
    }
    return json({ mode: "recipients", sent, failed, results: out });
  }

  // ---- 2. Create the digest (shared by the account + legacy sends) ----
  const { data: digest, error: digestError } = await supabase
    .from("digests")
    .insert({ article_ids: [], recipients: 0 })
    .select("id")
    .single();
  if (digestError) return json({ error: digestError.message }, 500);
  const digestId = digest!.id as string;

  const usedArticleIds = new Set<string>();
  const usedEditorialIds = new Set<string>();
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const planTally: Record<string, number> = {};
  const subjectDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" });

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
    for (const p of Object.values(profMap)) accountEmails.add(p.email);
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
          const html = renderShell(prof.full_name, built.intro, built.sections);
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
    .filter((s) => subscriberIds.length > 0 || !accountEmails.has(s.email));

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
      const html = renderEmail(sub, plan, selection);
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
  if (!testEmail) {
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

  // General wrap — daily only, ten stories.
  if (type === "news_rhythm") {
    const wrap = wrapPool.slice(0, WRAP_COUNT);
    if (wrap.length === 0) return [];
    const selection: Selection = { wrap, shorts: [], caseStudy: null, shortsCategory: null };
    return [{
      subject: `${subjectDate} - Shortly Daily Headlines`,
      intro: `Here are today's ${wrap.length} biggest stories, minus the noise. You'll be caught up SHORTLY!`,
      sections: renderSection("Quick Hits. Daily Wrap", "#6d28d9", wrap),
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
        subject: `${subjectDate} - Shortly ${name} Case Study`,
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
        subject: `${subjectDate} - Shortly ${name} Weekly Briefing`,
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
async function loadCaseStudies(supabase: ReturnType<typeof createClient>, istStart: string, istEnd: string): Promise<Record<string, CaseStudy>> {
  const map: Record<string, CaseStudy> = {};

  const { data: drafts } = await supabase
    .from("editorial_drafts")
    .select("id,topic_slug,topic_name,headline,summary,detail,primary_source_url,primary_source_title,generated_at,updated_at")
    .eq("status", "approved")
    .gte("updated_at", istStart)
    .lt("updated_at", istEnd)
    .order("generated_at", { ascending: false })
    .limit(50);
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
  if (plan === "case-only" && category) return `${subjectDate} - Shortly ${category} Case Study`;
  if (plan === "category-case" && category) return `${subjectDate} - Your Shortly ${category} brief`;
  if (plan === "wrap-category" && category) return `${subjectDate} - Shortly Daily Wrap + ${category}`;
  return `${subjectDate} - Shortly Daily Wrap is here!`;
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
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px;padding:0 10px"><tr>
      <td style="width:240px">
        <div style="background:${bg};color:#ffffff;border:3px solid #111111;font-size:14px;font-weight:800;letter-spacing:0.02em;text-transform:uppercase;text-align:center;padding:4px 12px;font-family:Roboto,Arial,sans-serif">${escapeHtml(text)}</div>
      </td>
      <td style="border-bottom:3px solid #111111">&nbsp;</td>
    </tr></table>`;
}

function renderItems(articles: Article[]): string {
  return articles.map((a, i) => {
    const headline = (a.edited_title || a.title || "").trim();
    const text = (a.edited_summary || a.summary || "").trim();
    return `
      <tr><td style="padding:0 0 16px">
        <div style="background:#ffffff;border:3px solid #111111;border-radius:12px;padding:18px 18px 18px 16px">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
            <td style="width:44px;vertical-align:top;padding-top:2px">
              <div style="width:36px;height:36px;border-radius:50%;background:#efe7ff;color:#6d28d9;border:2px solid #6d28d9;font-size:15px;font-weight:700;text-align:center;line-height:32px">${i + 1}</div>
            </td>
            <td style="padding-left:14px">
              <h2 style="font-size:18px;line-height:1.28;margin:0 0 10px;color:#191919;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${escapeHtml(headline)}</h2>
              <p style="font-size:15px;line-height:1.72;color:#2f2f39;margin:0;font-family:Roboto,Arial,sans-serif">${escapeHtml(text)}</p>
            </td>
          </tr></table>
        </div>
      </td></tr>`;
  }).join("");
}

function renderSection(label: string, bg: string, articles: Article[]): string {
  if (articles.length === 0) return "";
  return `
    ${renderLabelBar(label, bg)}
    <div style="margin-bottom:22px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${renderItems(articles)}</table>
    </div>`;
}

function renderCaseStudy(cs: CaseStudy): string {
  const paragraphs = (cs.detail || cs.summary || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="font-size:15px;line-height:1.74;color:#2f2f39;margin:0 0 12px;font-family:Roboto,Arial,sans-serif">${escapeHtml(p)}</p>`)
    .join("");
  const sourceLine = cs.source_url
    ? `<p style="font-size:13px;line-height:1.6;color:#6d28d9;margin:8px 0 0;font-family:Roboto,Arial,sans-serif"><a href="${escapeHtml(cs.source_url)}" style="color:#6d28d9;text-decoration:underline">Read the full source${cs.source ? ` - ${escapeHtml(cs.source)}` : ""}</a></p>`
    : "";
  return `
    ${renderLabelBar(`Case Study - ${cs.category}`, "#0f9d69")}
    <div style="margin-bottom:22px">
      <div style="background:#ffffff;border:3px solid #111111;border-radius:12px;padding:22px 22px 18px">
        <h2 style="font-size:21px;line-height:1.25;margin:0 0 12px;color:#191919;font-weight:800;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${escapeHtml(cs.headline)}</h2>
        ${cs.summary ? `<p style="font-size:16px;line-height:1.7;color:#191919;font-weight:500;margin:0 0 14px;font-family:Roboto,Arial,sans-serif">${escapeHtml(cs.summary)}</p>` : ""}
        ${paragraphs}
        ${sourceLine}
      </div>
    </div>`;
}

function renderEmail(sub: Subscriber, plan: string, selection: Selection): string {
  let sections = "";
  if (plan === "wrap-category") {
    sections += renderSection("Quick Hits. Daily Wrap", "#6d28d9", selection.wrap);
    sections += renderSection(`${selection.shortsCategory ?? "Category"} Briefs`, "#b45309", selection.shorts);
  } else if (plan === "category-case") {
    sections += renderSection(`${selection.shortsCategory ?? "Category"} Briefs`, "#b45309", selection.shorts);
    if (selection.caseStudy) sections += renderCaseStudy(selection.caseStudy);
  } else if (plan === "case-only") {
    if (selection.caseStudy) sections += renderCaseStudy(selection.caseStudy);
  } else {
    sections += renderSection("Quick Hits. Daily Wrap", "#6d28d9", selection.wrap);
  }
  return renderShell(sub.full_name, introFor(plan, selection), sections);
}

function renderShell(fullName: string | null, intro: string, sections: string): string {
  const greeting = fullName ? `Hi ${escapeHtml(fullName)},` : "Hi there,";
  const shareUrl = SITE_URL ? `${SITE_URL}/subscribe.html?utm_source=email&utm_medium=share&utm_campaign=subscribe` : "";
  const shareMessage = "Click here to subscribe to Shortly:";
  const twitterUrl = shareUrl
    ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}&url=${encodeURIComponent(shareUrl)}`
    : `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}`;
  const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl || BANNER_URL)}`;
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${shareMessage} ${shareUrl}`.trim())}`;

  return `
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;800&family=Roboto+Serif:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <div style="margin:0;background:#fcfbf7;padding:0;font-family:Roboto,Arial,sans-serif;color:#191919">
    <div style="max-width:640px;margin:0 auto">
      <img src="${BANNER_URL}" alt="Shortly" width="640" style="display:block;width:100%;max-width:640px;height:auto;border-radius:0 0 16px 16px">

      ${renderLabelBar("From the Shortly Team", "#0f9d69")}
      <div style="background:#ffffff;border-radius:12px;padding:26px 28px;margin:0 0 24px;border:3px solid #111111">
        <p style="margin:0 0 12px;color:#191919;font-size:18px;line-height:1.3;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${greeting}</p>
        <p style="margin:0;color:#2f2f39;font-size:16px;line-height:1.7;font-family:Roboto,Arial,sans-serif">${intro}</p>
      </div>

      ${sections}

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:4px;margin-bottom:20px">
        <tr><td style="text-align:center;padding:10px 20px 14px">
          <img src="${FOOTER_LOGO_URL}" alt="Shortly" width="96" style="display:block;width:96px;max-width:100%;height:auto;margin:0 auto 8px">
          <p style="margin:0 0 10px;color:#9a9ab0;font-size:12px;line-height:1.5;font-family:Roboto,Arial,sans-serif">Curated news, summarized daily.<br>You're receiving this because you subscribed to Shortly.</p>
          <div style="text-align:center">
            <a href="${twitterUrl}" style="display:inline-block;margin:0 6px;color:#6d28d9;text-decoration:none;font-size:12px;font-weight:700">X</a>
            <a href="${linkedinUrl}" style="display:inline-block;margin:0 6px;color:#6d28d9;text-decoration:none;font-size:12px;font-weight:700">LinkedIn</a>
            <a href="${whatsappUrl}" style="display:inline-block;margin:0 6px;color:#6d28d9;text-decoration:none;font-size:12px;font-weight:700">WhatsApp</a>
          </div>
        </td></tr>
      </table>
    </div>
  </div>`;
}

function introFor(plan: string, selection: Selection): string {
  const cat = selection.shortsCategory ?? selection.caseStudy?.category ?? "your category";
  switch (plan) {
    case "category-case":
      return `Your ${escapeHtml(cat)} briefing: ${selection.shorts.length} quick updates${selection.caseStudy ? " plus today's deep-dive case study" : ""}. You'll be caught up SHORTLY!`;
    case "wrap-category":
      return `The day's biggest stories plus ${selection.shorts.length} fresh ${escapeHtml(cat)} updates, minus the noise. Grab your coffee.`;
    case "case-only":
      return `Today's ${escapeHtml(cat)} case study - one story worth understanding properly.`;
    default:
      return `Here are ${selection.wrap.length} things that deserve your attention. The biggest stories, minus the noise. Grab your coffee &mdash; you'll be caught up SHORTLY!`;
  }
}
