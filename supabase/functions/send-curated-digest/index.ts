import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { sendEmail } from "../_shared/mailer.ts";

type Subscriber = { id: string; email: string; full_name: string | null };
type DailyArticle = {
  id: string;
  title: string;
  edited_title: string | null;
  summary: string | null;
  edited_summary: string | null;
  url: string;
  source: string | null;
  topic: string | null;
  rank_score: number | null;
  scraped_at: string;
};
type CorporateCase = {
  id: string;
  headline: string;
  summary: string;
  detail: string;
  source_url: string;
  source: string | null;
  generated_at: string;
};

const BANNER_URL =
  Deno.env.get("SHORTLY_BANNER_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/email-banner.jpg";
const FOOTER_LOGO_URL =
  Deno.env.get("SHORTLY_FOOTER_LOGO_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/footer-logo.png";
const SITE_URL = (Deno.env.get("SHORTLY_SITE_URL") ?? "").replace(/\/+$/, "");
const FORMATS = {
  "daily-wrap-10": { dailyLimit: 5, caseLimit: 0, label: "Daily Wrap 5" },
  "category-5-case-1": { dailyLimit: 5, caseLimit: 0, label: "Category 5 Articles", requiresCategory: true },
  "case-study-only": { dailyLimit: 0, caseLimit: 1, label: "Case Study Only" }
} as const;

type DigestFormat = keyof typeof FORMATS;

// Selected articles older than this are treated as stale and dropped.
const FRESH_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
function isFresh(scrapedAt: string): boolean {
  const t = new Date(scrapedAt).getTime();
  return Number.isFinite(t) && (Date.now() - t) <= FRESH_WINDOW_MS;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await request.json().catch(() => ({}));
  if (body?.manual !== true) {
    return json({ error: "Manual curated sends only." }, 403);
  }

  const format = normalizeFormat(body?.format);
  if (!format) return json({ error: "Unknown format" }, 400);
  const config = FORMATS[format];
  const category = String(body?.category || "").trim();
  const subscriberIds = Array.isArray(body?.subscriber_ids)
    ? body.subscriber_ids.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const articleIds = Array.isArray(body?.article_ids)
    ? body.article_ids.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const corporateCaseId = typeof body?.corporate_case_id === "string" && body.corporate_case_id.trim()
    ? body.corporate_case_id.trim()
    : "";
  const dryRun = body?.dry_run === true;
  const forceSend = body?.force === true;

  if (config.requiresCategory && !category) {
    return json({ error: "Category is required for this format" }, 400);
  }

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  // Duplicate guard: skip if a real digest was sent in the last 2 minutes.
  if (!dryRun && !forceSend) {
    const recentCutoff = new Date(Date.now() - 120 * 1000).toISOString();
    const { data: recent } = await supabase
      .from("digests").select("id").gt("recipients", 0).gte("sent_at", recentCutoff)
      .order("sent_at", { ascending: false }).limit(1).maybeSingle();
    if (recent) return json({ skipped: true, reason: "A digest was already sent in the last 2 minutes.", digestId: recent.id });
  }

  // Send EXACTLY what QA selected. No auto-fill, no auto-approve.
  const dailyArticles = config.dailyLimit > 0
    ? await resolveSelectedArticles(supabase, articleIds, config.dailyLimit)
    : [];
  const corporateCases = config.caseLimit > 0
    ? await resolveCorporateCases(supabase, { limit: config.caseLimit, corporateCaseId })
    : [];

  if (config.dailyLimit > 0 && dailyArticles.length === 0) {
    return json({ error: "Select the daily articles to send for this format" }, 400);
  }
  if (corporateCases.length < config.caseLimit) {
    return json({ error: "No approved corporate case study available" }, 400);
  }

  const subscribers = await loadSubscribers(supabase, format, subscriberIds, category);
  if (subscribers.length === 0) return json({ error: "No subscribers" }, 400);

  if (dryRun) {
    return json({ dryRun: true, format, category, recipients: subscribers.length, daily: dailyArticles.length, corporate: corporateCases.length });
  }

  const { data: digest, error: digestError } = await supabase
    .from("digests")
    .insert({ article_ids: dailyArticles.map((article) => article.id), recipients: subscribers.length })
    .select("id")
    .single();
  if (digestError) return json({ error: digestError.message }, 500);
  const digestId = digest!.id as string;

  const subjectDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const subject = format === "daily-wrap-10"
    ? `${subjectDate} - Shortly Daily Wrap is here!`
    : format === "category-5-case-1"
      ? `${subjectDate} - ${category} from Shortly`
      : `${subjectDate} - Shortly Case Study`;

  let sent = 0;
  let failed = 0;
  const batchSize = 5;

  for (let i = 0; i < subscribers.length; i += batchSize) {
    const batch = subscribers.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (subscriber) => {
      const result = await sendEmail({
        to: subscriber.email,
        subject,
        html: renderDigest({ format, category, dailyArticles, corporateCases, subscriber })
      });
      await supabase.from("article_deliveries").insert({
        digest_id: digestId,
        subscriber_id: subscriber.id,
        email: subscriber.email,
        status: result.ok ? "sent" : "failed",
        provider_message_id: result.messageId ?? null,
        error: result.error ?? null
      });
      return result.ok;
    }));
    sent += results.filter(Boolean).length;
    failed += results.length - results.filter(Boolean).length;
  }

  if (dailyArticles.length > 0) {
    await supabase
      .from("articles")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .in("id", dailyArticles.map((article) => article.id));
  }

  await supabase.from("digests").update({ sent, failed }).eq("id", digestId);

  return json({ digestId, format, category, recipients: subscribers.length, daily: dailyArticles.length, corporate: corporateCases.length, sent, failed });
});

function normalizeFormat(value: unknown): DigestFormat | null {
  const format = String(value || "").trim();
  return format in FORMATS ? format as DigestFormat : null;
}

// Exactly the QA-selected approved articles, in selection order. No padding.
async function resolveSelectedArticles(supabase: any, articleIds: string[], limit: number): Promise<DailyArticle[]> {
  if (articleIds.length === 0) return [];
  const { data, error } = await supabase
    .from("articles")
    .select("id,title,edited_title,summary,edited_summary,url,source,topic,rank_score,scraped_at")
    .in("id", articleIds)
    .eq("status", "approved");
  if (error) throw new Error(error.message);
  const byId = new Map(((data ?? []) as DailyArticle[]).map((article) => [article.id, article]));
  return articleIds
    .map((id) => byId.get(id))
    .filter((article): article is DailyArticle => Boolean(article))
    .filter((article) => isFresh(article.scraped_at))
    .slice(0, limit);
}

async function resolveCorporateCases(supabase: any, input: { limit: number; corporateCaseId: string }): Promise<CorporateCase[]> {
  const selected = input.corporateCaseId ? await fetchSelectedCorporateCase(supabase, input.corporateCaseId) : [];
  if (selected.length >= input.limit) return selected.slice(0, input.limit);

  const usedIds = new Set(selected.map((item) => item.id));
  const { data, error } = await supabase
    .from("corporate_cases")
    .select("id,headline,summary,detail,source_url,source,generated_at")
    .eq("status", "approved")
    .order("generated_at", { ascending: false })
    .limit(input.limit + 4);
  if (error) throw new Error(error.message);
  const extras = ((data ?? []) as CorporateCase[]).filter((item) => !usedIds.has(item.id));
  return [...selected, ...extras].slice(0, input.limit);
}

async function fetchSelectedCorporateCase(supabase: any, id: string): Promise<CorporateCase[]> {
  const { data, error } = await supabase
    .from("corporate_cases")
    .select("id,headline,summary,detail,source_url,source,generated_at")
    .eq("id", id)
    .eq("status", "approved");
  if (error) throw new Error(error.message);
  return (data ?? []) as CorporateCase[];
}

function normalizeTopicSlug(value = ""): string {
  const slug = String(value).trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["daily", "shortly", "shortly-daily-wrap"].includes(slug)) return "daily-wrap";
  if (["corporate", "case-study"].includes(slug)) return "corporate-case";
  if (["realestate", "property"].includes(slug)) return "real-estate";
  if (slug === "policy") return "policy-partner";
  if (["money", "finance"].includes(slug)) return "money-matters";
  if (["wellness", "health"].includes(slug)) return "wellness-daily";
  return slug;
}

async function loadSubscribers(supabase: any, format: DigestFormat, subscriberIds: string[], category = ""): Promise<Subscriber[]> {
  let query = supabase
    .from("subscribers")
    .select("id,email,full_name")
    .eq("status", "subscribed");

  if (subscriberIds.length > 0) {
    query = query.in("id", subscriberIds);
  } else if (format === "case-study-only") {
    query = query.contains("topics", ["corporate-case"]);
  } else if (format === "category-5-case-1") {
    query = query.contains("topics", [normalizeTopicSlug(category)]);
  } else {
    query = query.contains("topics", ["daily-wrap"]);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Subscriber[];
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

function renderCards(items: Array<{ headline: string; body: string }>): string {
  return items.map((item, index) => `
    <tr><td style="padding:0 0 16px">
      <div style="background:#ffffff;border:3px solid #111111;border-radius:12px;padding:18px 18px 18px 16px">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
          <td style="width:44px;vertical-align:top;padding-top:2px">
            <div style="width:36px;height:36px;border-radius:50%;background:#efe7ff;color:#6d28d9;border:2px solid #6d28d9;font-size:15px;font-weight:700;text-align:center;line-height:32px">${index + 1}</div>
          </td>
          <td style="padding-left:14px">
            <h2 style="font-size:18px;line-height:1.28;margin:0 0 10px;color:#191919;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${escapeHtml(item.headline)}</h2>
            <p style="font-size:15px;line-height:1.72;color:#2f2f39;margin:0;font-family:Roboto,Arial,sans-serif">${escapeHtml(item.body)}</p>
          </td>
        </tr></table>
      </div>
    </td></tr>`).join("");
}

function renderSection(label: string, items: Array<{ headline: string; body: string }>, color = "#6d28d9"): string {
  if (items.length === 0) return "";
  return `${renderLabelBar(label, color)}
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      ${renderCards(items)}
    </table>`;
}

function renderDigest(input: {
  format: DigestFormat;
  category: string;
  dailyArticles: DailyArticle[];
  corporateCases: CorporateCase[];
  subscriber: Subscriber;
}): string {
  const greeting = input.subscriber.full_name ? `Hi ${escapeHtml(input.subscriber.full_name)},` : "Hi there,";
  const shareUrl = SITE_URL ? `${SITE_URL}/subscribe.html?utm_source=email&utm_medium=share&utm_campaign=subscribe` : "";
  const shareMessage = "Click here to subscribe to Shortly:";
  const twitterUrl = shareUrl
    ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}&url=${encodeURIComponent(shareUrl)}`
    : `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}`;
  const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl || BANNER_URL)}`;
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${shareMessage} ${shareUrl}`.trim())}`;

  const intro = input.format === "daily-wrap-10"
    ? "Here are the stories that deserve your attention. The biggest news, minus the noise. Grab your coffee - you'll be caught up SHORTLY!"
    : input.format === "category-5-case-1"
      ? `Here are 5 stories from ${escapeHtml(input.category)}. The biggest updates from this bucket, minus the noise.`
      : "Here is today's Shortly case study, designed as one focused long-form read.";

  const dailyCards = input.dailyArticles.map((article) => ({
    headline: article.edited_title || article.title,
    body: article.edited_summary || article.summary || ""
  }));
  const caseCards = input.corporateCases.map((item) => ({
    headline: item.headline,
    body: `${item.summary}\n\n${item.detail}`.trim()
  }));
  const dailyLabel = input.format === "category-5-case-1" && input.category
    ? `Quick Hits. ${input.category}`
    : "Quick Hits. Daily Wrap";

  return `
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;800&family=Roboto+Serif:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <div style="margin:0;background:#fcfbf7;padding:0;font-family:Roboto,Arial,sans-serif;color:#191919">
    <div style="max-width:640px;margin:0 auto">
      <img src="${BANNER_URL}" alt="Shortly" width="640" style="display:block;width:100%;max-width:640px;height:auto;border-radius:0 0 16px 16px">
      ${renderLabelBar("From the Shortly Team", "#0f9d69")}
      <div style="background:#ffffff;border-radius:12px;padding:26px 28px;margin:0 0 24px;border:3px solid #111111">
        <p style="margin:0 0 12px;color:#191919;font-size:18px;line-height:1.3;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${greeting}</p>
        <p style="margin:0;color:#2f2f39;font-size:16px;line-height:1.7;font-weight:400;font-family:Roboto,Arial,sans-serif">${intro}</p>
      </div>
      ${renderSection(dailyLabel, dailyCards, "#6d28d9")}
      ${renderSection("Case Study", caseCards, "#0f9d69")}
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:4px;margin-bottom:20px">
        <tr><td style="text-align:center;padding:10px 20px 14px">
          <img src="${FOOTER_LOGO_URL}" alt="Shortly" width="96" style="display:block;width:96px;max-width:100%;height:auto;margin:0 auto 8px">
          <p style="margin:0 0 10px;color:#9a9ab0;font-size:12px;line-height:1.5;font-family:Roboto,Arial,sans-serif">Curated news, summarized daily.<br>You're receiving this because you subscribed to Shortly.</p>
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
