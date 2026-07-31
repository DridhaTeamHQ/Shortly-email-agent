// send-topic-digest: Sends approved topic newsletters by subscriber preference.
// Supports one selected topic or an all-topics digest for the default audience.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { sendEmail } from "../_shared/mailer.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { renderPrivacyFooter } from "../_shared/privacy.ts";
import { matchesCategoryContent } from "../_shared/category-quality.ts";

type Subscriber = { id: string; email: string; full_name: string | null; topics?: string[] | null };
type DailyArticle = {
  id: string;
  title: string;
  edited_title: string | null;
  summary: string | null;
  edited_summary: string | null;
  url: string;
  source: string | null;
  topic: string | null;
  category: string | null;
  scraped_at: string;
};
type EditorialDraft = {
  id: string;
  topic_slug: string;
  topic_name: string;
  format: "single" | "hybrid";
  headline: string;
  summary: string;
  detail: string;
  content: Record<string, any>;
  source_links: Array<{ source?: string; url?: string }>;
  primary_source_url: string;
  status: string;
  generated_at: string;
};
type DigestItem = {
  id: string;
  topic: string;
  section: string;
  headline: string;
  body: string;
  sourceUrl?: string;
  source?: string | null;
};

const TOPIC_LABELS: Record<string, string> = {
  "daily-wrap": "Daily Wrap",
  "real-estate": "Real Estate",
  "automobile": "Automobile",
  "health-wellness": "Health & Wellness",
  "tech-ai": "Tech & AI",
  "markets-startups": "Markets & Startups",
  "all-topics": "All Topics",
  "case-study-pool": "Case Study",
};
const TOPIC_SLUGS = Object.keys(TOPIC_LABELS);
const CASE_STUDY_TOPICS = ["real-estate", "automobile", "health-wellness", "tech-ai", "markets-startups"];
const TOPIC_CATEGORY_LABELS: Record<string, string> = {
  "real-estate": "Real Estate",
  "automobile": "Automobile",
  "health-wellness": "Health & Wellness",
  "tech-ai": "Tech & AI",
  "markets-startups": "Markets & Startups",
};
const BANNER_URL =
  Deno.env.get("SHORTLY_BANNER_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/figma-email-banner.png";
const FOOTER_LOGO_URL =
  Deno.env.get("SHORTLY_FOOTER_LOGO_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/footer-logo.png";
const SITE_URL = (Deno.env.get("SHORTLY_SITE_URL") ?? "").replace(/\/+$/, "");
const AUTO_TOPIC_DIGEST_ENABLED = (Deno.env.get("SHORTLY_AUTO_TOPIC_DIGEST_ENABLED") ?? "false").toLowerCase() === "true";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Server-side auth: service_role JWT (cron) or the dashboard's agent token.
  const denied = await requireAgent(request);
  if (denied) return denied;


  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const topic = normalizeTopic(body?.topic ?? "all-topics");
  const isManual = body?.manual === true;
  const dryRun = body?.dry_run === true;
  const forceSend = body?.force === true;
  const subscriberIds = Array.isArray(body?.subscriber_ids)
    ? body.subscriber_ids.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
    : [];

  if (!TOPIC_SLUGS.includes(topic)) return json({ error: "Unknown topic" }, 400);
  if (!isManual && !dryRun && !AUTO_TOPIC_DIGEST_ENABLED) {
    return json({ error: "Automatic topic digest sending is turned off for now." }, 403);
  }

  let supabase;
  let items: DigestItem[] = [];
  let subscribers: Subscriber[] = [];
  try {
    supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

    [items, subscribers] = await Promise.all([
      loadDigestItems(supabase, topic),
      loadSubscribers(supabase, topic, subscriberIds),
    ]);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Topic digest failed to load" }, 500);
  }

  if (items.length === 0) return json({ error: `No approved ${topicLabel(topic)} items available to send` }, 400);
  if (subscribers.length === 0) return json({ error: "No subscribers" }, 400);

  if (!dryRun && !forceSend) {
    const recentDuplicate = await findRecentDuplicateDigest(
      supabase,
      digestContentIds(items),
      subscribers.length,
    );
    if (recentDuplicate) {
      return json({
        skipped: true,
        reason: "This same article set was already sent in the last 2 minutes.",
        digestId: recentDuplicate.id
      });
    }
  }

  if (dryRun) {
    return json({ dryRun: true, topic, topicLabel: topicLabel(topic), items: items.length, recipients: subscribers.length });
  }

  const dailyIds = digestContentIds(items);
  const { data: digest, error: digestError } = await supabase
    .from("digests")
    .insert({ article_ids: dailyIds, recipients: subscribers.length })
    .select("id")
    .single();
  if (digestError) return json({ error: digestError.message }, 500);
  const digestId = digest!.id as string;

  const subjectDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const subject = topic === "case-study-pool"
    ? `${subjectDate} - Daily Mattr Case Study`
    : topic === "all-topics"
    ? `${subjectDate} - Daily Mattr topic digest is here!`
    : `${subjectDate} - ${topicLabel(topic)} from Daily Mattr`;

  let sent = 0;
  let failed = 0;
  const batchSize = 5;

  for (let i = 0; i < subscribers.length; i += batchSize) {
    const batch = subscribers.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (sub) => {
      const result = await sendEmail({ to: sub.email, subject, html: await renderDigest(items, sub, topic) });
      await supabase.from("article_deliveries").insert({
        digest_id: digestId,
        subscriber_id: sub.id,
        email: sub.email,
        status: result.ok ? "sent" : "failed",
        provider_message_id: result.messageId ?? null,
        error: result.error ?? null,
      });
      return result.ok;
    }));
    sent += results.filter(Boolean).length;
    failed += results.length - results.filter(Boolean).length;
  }

  await supabase.from("digests").update({ sent, failed }).eq("id", digestId);

  // Consume content only after every recipient succeeds. A partial send stays
  // approved so the operator can retry failed deliveries.
  if (failed === 0) {
    const articleIds = items.filter((item) => item.topic === "daily-wrap").map((item) => item.id);
    if (articleIds.length > 0) {
      await supabase.from("articles").update({ status: "sent", sent_at: new Date().toISOString() }).in("id", articleIds);
    }
    const draftIds = [...new Set(items
      .filter((item) => item.topic !== "daily-wrap")
      .map((item) => item.id.split(":", 1)[0]))];
    if (draftIds.length > 0) {
      await supabase.from("editorial_drafts").update({ status: "published", updated_at: new Date().toISOString() }).in("id", draftIds);
    }
  }

  return json({ digestId, topic, items: items.length, recipients: subscribers.length, sent, failed });
});

function normalizeTopic(value: unknown): string {
  const slug = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["daily", "shortly", "shortly-daily-wrap"].includes(slug)) return "daily-wrap";
  if (["case-study-pool", "case-pool", "case-study-daily", "daily-case-study"].includes(slug)) return "case-study-pool";
  if (["all", "all-topic", "all-topics", "default"].includes(slug)) return "all-topics";
  if (["realestate", "property"].includes(slug)) return "real-estate";
  if (["auto", "cars", "automotive"].includes(slug)) return "automobile";
  if (["wellness", "health", "wellness-daily"].includes(slug)) return "health-wellness";
  if (["tech", "technology", "ai"].includes(slug)) return "tech-ai";
  if (["money", "finance", "money-matters", "markets", "startups"].includes(slug)) return "markets-startups";
  return slug;
}

function topicLabel(topic: string): string {
  return TOPIC_LABELS[topic] ?? topic;
}

async function findRecentDuplicateDigest(
  supabase: any,
  articleIds: string[],
  recipients: number,
): Promise<{ id: string } | null> {
  if (articleIds.length === 0 || recipients <= 0) return null;
  const recentCutoff = new Date(Date.now() - 120 * 1000).toISOString();
  const { data, error } = await supabase
    .from("digests")
    .select("id,article_ids,recipients")
    .gt("recipients", 0)
    .gte("sent_at", recentCutoff)
    .order("sent_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);

  const target = [...articleIds].sort().join("|");
  return ((data ?? []) as Array<{ id: string; article_ids: string[] | null; recipients: number }>)
    .find((digest) =>
      Number(digest.recipients ?? 0) === recipients &&
      [...(digest.article_ids ?? [])].sort().join("|") === target
    ) ?? null;
}

function digestContentIds(items: DigestItem[]): string[] {
  return [...new Set(items.map((item) => item.id.split(":", 1)[0]))];
}

function istDayWindow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const start = Date.UTC(value("year"), value("month") - 1, value("day")) - 5.5 * 60 * 60 * 1000;
  return { start: new Date(start).toISOString(), end: new Date(start + 24 * 60 * 60 * 1000).toISOString() };
}

async function loadSubscribers(supabase: any, topic: string, subscriberIds: string[]): Promise<Subscriber[]> {
  let query = supabase
    .from("subscribers")
    .select("id,email,full_name,topics")
    .eq("status", "subscribed");
  if (topic === "case-study-pool") {
    query = query.overlaps("topics", CASE_STUDY_TOPICS);
  } else if (topic !== "all-topics") {
    query = query.contains("topics", [topic]);
  }
  if (subscriberIds.length > 0) {
    query = query.in("id", subscriberIds);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Subscriber[];
}

async function loadDigestItems(supabase: any, topic: string): Promise<DigestItem[]> {
  if (topic === "daily-wrap") return loadDailyItems(supabase);
  if (topic === "case-study-pool") return loadCaseStudyPoolItem(supabase);
  if (topic !== "all-topics") return loadTopicShortItems(supabase, topic);

  const [daily, editorial] = await Promise.all([
    loadDailyItems(supabase),
    loadEditorialItems(supabase, "all-topics"),
  ]);
  return [...daily, ...editorial];
}

async function loadDailyItems(supabase: any): Promise<DigestItem[]> {
  const { start, end } = istDayWindow();
  const { data, error } = await supabase
    .from("articles")
    .select("id,title,edited_title,summary,edited_summary,url,source,topic,category,scraped_at")
    .eq("status", "approved")
    .is("category", null)
    .gte("scraped_at", start)
    .lt("scraped_at", end)
    .order("rank_score", { ascending: false })
    .order("scraped_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);

  return ((data ?? []) as DailyArticle[]).map((article) => ({
    id: article.id,
    topic: "daily-wrap",
    section: "Daily Wrap",
    headline: article.edited_title || article.title,
    body: article.edited_summary || article.summary || "",
    sourceUrl: article.url,
    source: article.source,
  }));
}

async function loadTopicShortItems(supabase: any, topic: string): Promise<DigestItem[]> {
  const { start, end } = istDayWindow();
  const category = TOPIC_CATEGORY_LABELS[topic];
  if (!category) return [];

  const { data, error } = await supabase
    .from("articles")
    .select("id,title,edited_title,summary,edited_summary,url,source,topic,category,scraped_at,rank_score")
    .eq("status", "approved")
    .eq("category", category)
    .gte("scraped_at", start)
    .lt("scraped_at", end)
    .order("rank_score", { ascending: false })
    .order("scraped_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);

  return ((data ?? []) as DailyArticle[])
    .filter((article) =>
      matchesCategoryContent(category, article.edited_title || article.title, article.edited_summary || article.summary || "")
    )
    .map((article) => ({
      id: article.id,
      topic,
      section: topicLabel(topic),
      headline: article.edited_title || article.title,
      body: article.edited_summary || article.summary || "",
      sourceUrl: article.url,
      source: article.source,
    }));
}

async function loadEditorialItems(supabase: any, topic: string): Promise<DigestItem[]> {
  const { start, end } = istDayWindow();
  let query = supabase
    .from("editorial_drafts")
    .select("id,topic_slug,topic_name,format,headline,summary,detail,content,source_links,primary_source_url,status,generated_at")
    .eq("status", "approved")
    .gte("generated_at", start)
    .lt("generated_at", end)
    .order("generated_at", { ascending: false });
  if (topic !== "all-topics") {
    query = query.eq("topic_slug", topic).limit(1);
  } else {
    query = query.limit(50);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const drafts = (data ?? []) as EditorialDraft[];
  const selectedDrafts = topic === "all-topics"
    ? latestDraftPerTopic(drafts)
    : drafts.slice(0, 1);
  return selectedDrafts.flatMap(expandEditorialDraft);
}

async function loadCaseStudyPoolItem(supabase: any): Promise<DigestItem[]> {
  const pool = await loadEditorialDraftPool(supabase);
  if (pool.length === 0) return [];
  const picked = pool[Math.floor(Math.random() * pool.length)];
  return picked.items;
}

async function loadEditorialDraftPool(supabase: any): Promise<Array<{ generatedAt: string; items: DigestItem[] }>> {
  const { data, error } = await supabase
    .from("editorial_drafts")
    .select("id,topic_slug,topic_name,format,headline,summary,detail,content,source_links,primary_source_url,status,generated_at")
    .eq("status", "approved")
    .order("generated_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return ((data ?? []) as EditorialDraft[]).map((draft) => ({
    generatedAt: draft.generated_at,
    items: expandEditorialDraft(draft),
  }));
}

function latestDraftPerTopic(drafts: EditorialDraft[]): EditorialDraft[] {
  const seen = new Set<string>();
  return drafts.filter((draft) => {
    if (seen.has(draft.topic_slug)) return false;
    seen.add(draft.topic_slug);
    return true;
  });
}

function expandEditorialDraft(draft: EditorialDraft): DigestItem[] {
  const sourceName = (url?: string) =>
    draft.source_links?.find((item) => item.url === url)?.source || "Source";

  if (draft.format === "hybrid") {
    const briefs = Array.isArray(draft.content?.briefs) ? draft.content.briefs : [];
    const briefItems = briefs.map((brief: Record<string, string>, index: number) => ({
      id: `${draft.id}:brief:${index}`,
      topic: draft.topic_slug,
      section: `${draft.topic_name} - Brief ${index + 1}`,
      headline: brief.headline || `Brief ${index + 1}`,
      body: `${brief.what_happened || ""}\n\n${brief.why_it_matters || ""}`.trim(),
      sourceUrl: brief.source_url || draft.primary_source_url,
      source: sourceName(brief.source_url || draft.primary_source_url),
    }));
    const feature = draft.content?.feature ?? {};
    return [
      ...briefItems,
      {
        id: `${draft.id}:feature`,
        topic: draft.topic_slug,
        section: draft.topic_slug === "markets-startups" ? "Markets & Startups - Take" : `${draft.topic_name} - Feature`,
        headline: feature.headline || draft.headline,
        body: `${feature.summary || draft.summary || ""}\n\n${feature.detail || draft.detail || ""}`.trim(),
        sourceUrl: feature.source_url || draft.primary_source_url,
        source: sourceName(feature.source_url || draft.primary_source_url),
      },
    ];
  }

  return [{
    id: draft.id,
    topic: draft.topic_slug,
    section: draft.topic_name,
    headline: draft.headline,
    body: `${draft.summary}\n\n${draft.detail}`.trim(),
    sourceUrl: draft.primary_source_url,
    source: sourceName(draft.primary_source_url),
  }];
}

function escapeHtml(value = ""): string {
  return String(value)
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
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#020202"><tr><td style="padding:8px 24px;color:#dadada;font:12px/22px Roboto,Arial,sans-serif">From the Daily Mattr Team</td><td style="padding:8px 24px;color:#dadada;font:12px/22px Roboto,Arial,sans-serif;text-align:right">${today}</td></tr></table>`;
}

function renderHero(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#020202 url('${BANNER_URL}') center/cover no-repeat"><tr><td style="background:rgba(0,0,0,.68);padding:36px 24px 40px;text-align:center;color:#ffffff"><div style="font:700 24px/1 'Roboto Serif',Georgia,serif;margin-bottom:18px">DailyMattr<sup style="font-size:10px">®</sup></div><div style="font:900 54px/.95 Georgia,'Times New Roman',serif;letter-spacing:-.04em">LONG MATTR</div><div style="margin-top:14px;font:700 12px/1.2 Roboto,Arial,sans-serif;letter-spacing:.28em;text-transform:uppercase">Stories that matter</div></td></tr></table>`;
}

function renderFooter(subscribeUrl: string, twitterUrl: string, linkedinUrl: string, privacyFooter: string): string {
  const icon = (href: string, label: string) => `<a href="${href}" style="display:inline-block;width:28px;height:28px;line-height:28px;margin-right:10px;border-radius:50%;background:#000;color:#fff;text-align:center;text-decoration:none;font:700 14px/28px Arial,sans-serif">${label}</a>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:28px"><tr><td style="padding:18px 28px 14px;background:#fff"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td>${icon("https://www.instagram.com/dailymattr", "◎")}${icon(twitterUrl, "X")}${icon(linkedinUrl, "in")}</td><td style="text-align:right"><a href="${subscribeUrl}" style="display:inline-block;background:#202020;color:#fff;border-radius:24px;padding:12px 20px;text-decoration:none;font:700 15px/1 Roboto,Arial,sans-serif">Subscribe&nbsp; ↗</a></td></tr></table></td></tr><tr><td style="background:#050505;color:#fff;padding:16px 28px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="font:700 15px/1.2 Roboto,Arial,sans-serif">Read from anywhere</td><td style="text-align:right"><a href="#" style="display:inline-block;background:#202020;border:1px solid #333;border-radius:20px;color:#fff;padding:9px 14px;text-decoration:none;font:600 11px/1 Roboto,Arial,sans-serif">▷&nbsp; Google Play</a>&nbsp; <a href="#" style="display:inline-block;background:#202020;border:1px solid #333;border-radius:20px;color:#fff;padding:9px 14px;text-decoration:none;font:600 11px/1 Roboto,Arial,sans-serif">●&nbsp; App Store</a></td></tr></table></td></tr></table>${privacyFooter}`;
}

function renderTopicSections(items: DigestItem[]): string {
  const groups = new Map<string, DigestItem[]>();
  items.forEach((item) => {
    const label = topicLabel(item.topic);
    groups.set(label, [...(groups.get(label) ?? []), item]);
  });
  return [...groups.entries()].map(([label, group]) => `
    ${renderLabelBar(label, "#111111")}
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      ${renderRealItems(group)}
    </table>
  `).join("");
}

function renderRealItems(items: DigestItem[]): string {
  return items.map((item) => `
    <tr><td style="padding:0 0 16px">
      <div style="background:#f5f5f5;border:1px solid #e1e1e1;border-radius:10px;padding:16px 12px 14px">
        <h2 style="font-size:16px;line-height:1.32;margin:0 0 10px;color:#222222;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${escapeHtml(item.headline)}</h2>
        <p style="font-size:12px;line-height:1.2;margin:0 0 14px;color:#666666;font-family:Roboto,Arial,sans-serif">${escapeHtml(item.section)}</p>
        <p style="font-size:13px;line-height:1.55;color:#686868;margin:0 0 12px;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${escapeHtml(item.body)}</p>
        ${item.sourceUrl || item.source ? `<p style="font-size:11px;line-height:1.3;color:#777777;margin:0;font-family:Roboto,Arial,sans-serif">${item.sourceUrl ? `<a href="${escapeHtml(item.sourceUrl)}" style="color:#555555;text-decoration:none">${escapeHtml(item.source || "Read source")}</a>` : escapeHtml(item.source || "")}</p>` : ""}
      </div>
    </td></tr>`).join("");
}

async function renderDigest(items: DigestItem[], sub: Subscriber, topic: string): Promise<string> {
  const greeting = sub.full_name ? `Hi ${escapeHtml(sub.full_name)},` : "Hi there,";
  const shareUrl = SITE_URL ? `${SITE_URL}/subscribe.html?utm_source=email&utm_medium=share&utm_campaign=subscribe` : "";
  const shareMessage = "Click here to subscribe to Daily Mattr:";
  const twitterUrl = shareUrl
    ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}&url=${encodeURIComponent(shareUrl)}`
    : `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}`;
  const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl || BANNER_URL)}`;
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${shareMessage} ${shareUrl}`.trim())}`;
  const privacyFooter = await renderPrivacyFooter(sub.email);
  const intro = topic === "case-study-pool"
    ? "Here is today's Daily Mattr case study, picked from the approved case-study pool."
    : topic === "all-topics"
    ? "Here are the approved stories across Daily Mattr's topic newsletters, minus the noise."
    : `Here is today's approved ${topicLabel(topic)} edition from Daily Mattr, written for a fast and useful read.`;

  return `
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;800&family=Roboto+Serif:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <div style="margin:0;background:#ffffff;padding:0;font-family:Roboto,Arial,sans-serif;color:#191919">
    <div style="max-width:640px;margin:0 auto">
      ${renderTopMeta()}
      ${renderHero()}
      <div style="background:#ffffff;padding:24px;margin:0 0 22px;border-bottom:1px solid #d1d1d1">
        <p style="margin:0 0 12px;color:#191919;font-size:18px;line-height:1.3;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${greeting}</p>
        <p style="margin:0;color:#2f2f39;font-size:16px;line-height:1.7;font-weight:400;font-family:Roboto,Arial,sans-serif">${escapeHtml(intro)}</p>
      </div>
      ${renderTopicSections(items)}
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="display:none;margin-top:4px;margin-bottom:20px">
        <tr><td style="text-align:center;padding:10px 20px 14px">
          <div style="margin:0 auto 8px;color:#111111;font:700 24px/1 'Roboto Serif',Georgia,serif">DailyMattr<sup style="font-size:10px">®</sup></div>
          <p style="margin:0 0 10px;color:#9a9ab0;font-size:12px;line-height:1.5;font-family:Roboto,Arial,sans-serif">Curated news, summarized daily.<br>You're receiving this because you subscribed to Daily Mattr.</p>
          <div style="text-align:center">
            <a href="${twitterUrl}" style="display:inline-block;margin:0 8px;color:#111111;font-size:12px;font-family:Roboto,Arial,sans-serif">X</a>
            <a href="${linkedinUrl}" style="display:inline-block;margin:0 8px;color:#111111;font-size:12px;font-family:Roboto,Arial,sans-serif">LinkedIn</a>
            <a href="${whatsappUrl}" style="display:inline-block;margin:0 8px;color:#111111;font-size:12px;font-family:Roboto,Arial,sans-serif">WhatsApp</a>
          </div>
          ${privacyFooter}
        </td></tr>
      </table>
      ${renderFooter(shareUrl || SITE_URL || "#", twitterUrl, linkedinUrl, privacyFooter)}
    </div>
  </div>`;
}
