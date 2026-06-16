// send-topic-digest: Sends approved topic newsletters by subscriber preference.
// Supports one selected topic or an all-topics digest for the default audience.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { sendEmail } from "../_shared/mailer.ts";

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
};
type CorporateCase = {
  id: string;
  headline: string;
  summary: string;
  detail: string;
  source_url: string;
  source: string | null;
  status: string;
  generated_at: string;
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
  "corporate-case": "Corporate Case",
  "real-estate": "Real Estate",
  "policy-partner": "Policy Partner",
  "money-matters": "Money Matters",
  "wellness-daily": "Wellness Daily",
  "all-topics": "All Topics",
};
const TOPIC_SLUGS = Object.keys(TOPIC_LABELS);
const BANNER_URL =
  Deno.env.get("SHORTLY_BANNER_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/email-banner.jpg";
const FOOTER_LOGO_URL =
  Deno.env.get("SHORTLY_FOOTER_LOGO_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/footer-logo.png";
const SITE_URL = (Deno.env.get("SHORTLY_SITE_URL") ?? "").replace(/\/+$/, "");
const AUTO_TOPIC_DIGEST_ENABLED = (Deno.env.get("SHORTLY_AUTO_TOPIC_DIGEST_ENABLED") ?? "false").toLowerCase() === "true";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const topic = normalizeTopic(body?.topic ?? "all-topics");
  const isManual = body?.manual === true;
  const dryRun = body?.dry_run === true;
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

  if (dryRun) {
    return json({
      dryRun: true,
      topic,
      topicLabel: topicLabel(topic),
      items: items.length,
      recipients: subscribers.length,
    });
  }

  const dailyIds = items.filter((item) => item.topic === "daily-wrap").map((item) => item.id);
  const { data: digest, error: digestError } = await supabase
    .from("digests")
    .insert({ article_ids: dailyIds, recipients: subscribers.length })
    .select("id")
    .single();
  if (digestError) return json({ error: digestError.message }, 500);
  const digestId = digest!.id as string;

  const subjectDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const subject = topic === "all-topics"
    ? `${subjectDate} - Shortly topic digest is here!`
    : `${subjectDate} - ${topicLabel(topic)} from Shortly`;

  let sent = 0;
  let failed = 0;
  const batchSize = 5;

  for (let i = 0; i < subscribers.length; i += batchSize) {
    const batch = subscribers.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (sub) => {
      const result = await sendEmail({
        to: sub.email,
        subject,
        html: renderDigest(items, sub, topic),
      });
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

  return json({
    digestId,
    topic,
    items: items.length,
    recipients: subscribers.length,
    sent,
    failed,
  });
});

function normalizeTopic(value: unknown): string {
  const slug = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["daily", "shortly", "shortly-daily-wrap"].includes(slug)) return "daily-wrap";
  if (["all", "all-topic", "all-topics", "default"].includes(slug)) return "all-topics";
  if (["corporate", "case-study"].includes(slug)) return "corporate-case";
  if (["realestate", "property"].includes(slug)) return "real-estate";
  if (slug === "policy") return "policy-partner";
  if (["money", "finance"].includes(slug)) return "money-matters";
  if (["wellness", "health"].includes(slug)) return "wellness-daily";
  return slug;
}

function topicLabel(topic: string): string {
  return TOPIC_LABELS[topic] ?? topic;
}

async function loadSubscribers(supabase: any, topic: string, subscriberIds: string[]): Promise<Subscriber[]> {
  let query = supabase
    .from("subscribers")
    .select("id,email,full_name,topics")
    .eq("status", "subscribed");

  if (subscriberIds.length > 0) {
    query = query.in("id", subscriberIds);
  } else if (topic !== "all-topics") {
    query = query.contains("topics", [topic]);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Subscriber[];
}

async function loadDigestItems(supabase: any, topic: string): Promise<DigestItem[]> {
  if (topic === "daily-wrap") return loadDailyItems(supabase);
  if (topic === "corporate-case") return loadCorporateItems(supabase);
  if (topic !== "all-topics") return loadEditorialItems(supabase, topic);

  const [daily, corporate, editorial] = await Promise.all([
    loadDailyItems(supabase),
    loadCorporateItems(supabase),
    loadEditorialItems(supabase, "all-topics"),
  ]);
  return [...daily, ...corporate, ...editorial];
}

async function loadDailyItems(supabase: any): Promise<DigestItem[]> {
  const { data, error } = await supabase
    .from("articles")
    .select("id,title,edited_title,summary,edited_summary,url,source,topic")
    .eq("status", "approved")
    .order("rank_score", { ascending: false })
    .order("scraped_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);

  return ((data ?? []) as DailyArticle[]).map((article) => ({
    id: article.id,
    topic: "daily-wrap",
    section: article.topic || "Daily Wrap",
    headline: article.edited_title || article.title,
    body: article.edited_summary || article.summary || "",
    sourceUrl: article.url,
    source: article.source,
  }));
}

async function loadCorporateItems(supabase: any): Promise<DigestItem[]> {
  const { data, error } = await supabase
    .from("corporate_cases")
    .select("id,headline,summary,detail,source_url,source,status,generated_at")
    .eq("status", "approved")
    .order("generated_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);

  return ((data ?? []) as CorporateCase[]).map((item) => ({
    id: item.id,
    topic: "corporate-case",
    section: "Corporate Case",
    headline: item.headline,
    body: `${item.summary}\n\n${item.detail}`.trim(),
    sourceUrl: item.source_url,
    source: item.source,
  }));
}

async function loadEditorialItems(supabase: any, topic: string): Promise<DigestItem[]> {
  let query = supabase
    .from("editorial_drafts")
    .select("id,topic_slug,topic_name,format,headline,summary,detail,content,source_links,primary_source_url,status,generated_at")
    .eq("status", "approved")
    .order("generated_at", { ascending: false })
    .limit(12);
  if (topic !== "all-topics") query = query.eq("topic_slug", topic);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as EditorialDraft[]).flatMap(expandEditorialDraft);
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
        section: draft.topic_slug === "money-matters" ? "Money Matters - Take" : `${draft.topic_name} - Feature`,
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
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px;padding:0 10px"><tr>
      <td style="width:220px">
        <div style="background:${bg};color:#ffffff;border:3px solid #111111;font-size:14px;font-weight:800;letter-spacing:0.02em;text-transform:uppercase;text-align:center;padding:4px 12px;font-family:Roboto,Arial,sans-serif">${escapeHtml(text)}</div>
      </td>
      <td style="border-bottom:3px solid #111111">&nbsp;</td>
    </tr></table>`;
}

function renderItems(items: DigestItem[]): string {
  return items.map((item, index) => `
    <tr><td style="padding:0 0 16px">
      <div style="background:#ffffff;border:3px solid #111111;border-radius:12px;padding:18px 18px 18px 16px">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
          <td style="width:44px;vertical-align:top;padding-top:2px">
            <div style="width:36px;height:36px;border-radius:50%;background:#efe7ff;color:#6d28d9;border:2px solid #6d28d9;font-size:15px;font-weight:700;text-align:center;line-height:32px">
              ${index + 1}
            </div>
          </td>
          <td style="padding-left:14px">
            <p style="margin:0 0 6px;color:#6d28d9;font-size:11px;line-height:1.2;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;font-family:Roboto,Arial,sans-serif">${escapeHtml(item.section)}</p>
            <h2 style="font-size:18px;line-height:1.28;margin:0 0 10px;color:#191919;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">
              ${escapeHtml(item.headline)}
            </h2>
            <p style="font-size:15px;line-height:1.72;color:#2f2f39;margin:0 0 10px;font-family:Roboto,Arial,sans-serif">${escapeHtml(item.body)}</p>
            ${item.sourceUrl ? `<a href="${escapeHtml(item.sourceUrl)}" style="font-size:12px;color:#6d28d9;font-family:Roboto,Arial,sans-serif;text-decoration:none">Read source</a>` : ""}
          </td>
        </tr></table>
      </div>
    </td></tr>`).join("");
}

function renderTopicSections(items: DigestItem[]): string {
  const groups = new Map<string, DigestItem[]>();
  items.forEach((item) => {
    const label = topicLabel(item.topic);
    groups.set(label, [...(groups.get(label) ?? []), item]);
  });
  return [...groups.entries()].map(([label, group]) => `
    ${renderLabelBar(label, "#6d28d9")}
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      ${renderItems(group)}
    </table>
  `).join("");
}

function renderDigest(items: DigestItem[], sub: Subscriber, topic: string): string {
  const greeting = sub.full_name ? `Hi ${escapeHtml(sub.full_name)},` : "Hi there,";
  const shareUrl = SITE_URL ? `${SITE_URL}/subscribe.html?utm_source=email&utm_medium=share&utm_campaign=subscribe` : "";
  const shareMessage = "Click here to subscribe to Shortly:";
  const twitterUrl = shareUrl
    ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}&url=${encodeURIComponent(shareUrl)}`
    : `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}`;
  const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl || BANNER_URL)}`;
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${shareMessage} ${shareUrl}`.trim())}`;
  const intro = topic === "all-topics"
    ? "Here are the approved stories across Shortly's topic newsletters, minus the noise."
    : `Here is today's approved ${topicLabel(topic)} edition from Shortly, written for a fast and useful read.`;

  return `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;800&family=Roboto+Serif:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <div style="margin:0;background:#fcfbf7;padding:0;font-family:Roboto,Arial,sans-serif;color:#191919">
    <div style="max-width:640px;margin:0 auto">
      <img src="${BANNER_URL}" alt="Shortly Daily Wrap" width="640" style="display:block;width:100%;max-width:640px;height:auto;border-radius:0 0 16px 16px">
      ${renderLabelBar("From the Shortly Team", "#0f9d69")}
      <div style="background:#ffffff;border-radius:12px;padding:26px 28px;margin:0 0 24px;border:3px solid #111111">
        <p style="margin:0 0 12px;color:#191919;font-size:18px;line-height:1.3;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${greeting}</p>
        <p style="margin:0;color:#2f2f39;font-size:16px;line-height:1.7;font-weight:400;font-family:Roboto,Arial,sans-serif">${escapeHtml(intro)}</p>
      </div>
      ${renderTopicSections(items)}
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:4px;margin-bottom:20px">
        <tr><td style="text-align:center;padding:10px 20px 14px">
          <img src="${FOOTER_LOGO_URL}" alt="Shortly" width="96" style="display:block;width:96px;max-width:100%;height:auto;margin:0 auto 8px">
          <p style="margin:0 0 10px;color:#9a9ab0;font-size:12px;line-height:1.5;font-family:Roboto,Arial,sans-serif">
            Curated news, summarized daily.<br>
            You're receiving this because you subscribed to Shortly.
          </p>
          <p style="margin:0 0 8px;font-size:12px;color:#9a9ab0;font-family:Roboto,Arial,sans-serif">Can be forwarded to others.</p>
          <div style="text-align:center">
            <a href="${twitterUrl}" style="display:inline-block;margin:0 8px;color:#6d28d9;font-size:12px;font-family:Roboto,Arial,sans-serif">X</a>
            <a href="${linkedinUrl}" style="display:inline-block;margin:0 8px;color:#6d28d9;font-size:12px;font-family:Roboto,Arial,sans-serif">LinkedIn</a>
            <a href="${whatsappUrl}" style="display:inline-block;margin:0 8px;color:#6d28d9;font-size:12px;font-family:Roboto,Arial,sans-serif">WhatsApp</a>
          </div>
        </td></tr>
      </table>
    </div>
  </div>`;
}
