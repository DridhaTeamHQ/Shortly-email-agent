import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { sendEmail } from "../_shared/mailer.ts";
import { renderPrivacyFooter } from "../_shared/privacy.ts";
import { matchesCategoryContent } from "../_shared/category-quality.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { requireIstSendWindow } from "../_shared/send-window.ts";

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
  rank_score: number | null;
  scraped_at: string;
  reviewed_at: string | null;
};
// Case studies now come from editorial_drafts (corporate_cases is retired);
// rows are mapped into this shape so the renderer stays unchanged.
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
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/figma-email-banner.png";
const FOOTER_LOGO_URL =
  Deno.env.get("SHORTLY_FOOTER_LOGO_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/footer-logo.png";
const SITE_URL = (Deno.env.get("SHORTLY_SITE_URL") ?? "").replace(/\/+$/, "");
const FORMATS = {
  "daily-wrap-10": { dailyLimit: 5, caseLimit: 0, label: "General 5 Articles" },
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
  // Server-side auth: service_role JWT (cron) or the dashboard's agent token.
  const denied = await requireAgent(request);
  if (denied) return denied;

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
  const testEmail = typeof body?.test_email === "string" && body.test_email.includes("@")
    ? body.test_email.trim().toLowerCase()
    : "";
  const testName = typeof body?.test_name === "string" ? body.test_name.trim() : null;
  const dryRun = body?.dry_run === true;
  const forceSend = body?.force === true;
  const provider = body?.provider === "ses" ? "ses" : body?.provider === "brevo" ? "brevo" : undefined;
  const sendWindowDenied = requireIstSendWindow({ dryRun });
  if (sendWindowDenied) return sendWindowDenied;

  if (config.requiresCategory && !category) {
    return json({ error: "Category is required for this format" }, 400);
  }

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  // Send EXACTLY what QA selected. No auto-fill, no auto-approve.
  const dailyArticles = config.dailyLimit > 0
    ? await resolveSelectedArticles(supabase, articleIds, config.dailyLimit, category)
    : [];
  if (format === "daily-wrap-10" && dailyArticles.some((article) => article.category)) {
    return json({ error: "General sends can include only General articles, not category-specific articles." }, 400);
  }
  const corporateCases = config.caseLimit > 0
    ? await resolveCorporateCases(supabase, { limit: config.caseLimit, corporateCaseId })
    : [];

  if (config.dailyLimit > 0 && dailyArticles.length === 0) {
    return json({ error: "Select the daily articles to send for this format" }, 400);
  }
  if (corporateCases.length < config.caseLimit) {
    return json({ error: "No approved corporate case study available" }, 400);
  }

  const subscribers = testEmail
    ? [{ id: "test-recipient", email: testEmail, full_name: testName, topics: ["daily-wrap"] }]
    : await loadSubscribers(supabase, format, subscriberIds, category);
  if (subscribers.length === 0) return json({ error: "No subscribers" }, 400);

  if (!dryRun && !forceSend) {
    const recentDuplicate = await findRecentDuplicateDigest(
      supabase,
      digestContentIds(dailyArticles, corporateCases),
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
    return json({ dryRun: true, format, category, recipients: subscribers.length, daily: dailyArticles.length, corporate: corporateCases.length });
  }

  const { data: digest, error: digestError } = await supabase
    .from("digests")
    .insert({ article_ids: digestContentIds(dailyArticles, corporateCases), recipients: subscribers.length })
    .select("id")
    .single();
  if (digestError) return json({ error: digestError.message }, 500);
  const digestId = digest!.id as string;

  const subjectDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const subject = format === "daily-wrap-10"
    ? `${subjectDate} - Dailymattr Wrap is here!`
    : format === "category-5-case-1"
      ? `${subjectDate} - ${category} from Dailymattr`
      : `${subjectDate} - Dailymattr Case Study`;

  let sent = 0;
  let failed = 0;
  const batchSize = 5;

  for (let i = 0; i < subscribers.length; i += batchSize) {
    const batch = subscribers.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (subscriber) => {
      const result = await sendEmail({
        to: subscriber.email,
        subject,
        html: await renderDigest({ format, category, dailyArticles, corporateCases, subscriber }),
        provider,
      });
      await supabase.from("article_deliveries").insert({
        digest_id: digestId,
        subscriber_id: subscriber.id === "test-recipient" ? null : subscriber.id,
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

  // Keep content available when any recipient failed so it can be retried.
  if (!testEmail && dailyArticles.length > 0 && failed === 0) {
    await supabase
      .from("articles")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .in("id", dailyArticles.map((article) => article.id));
  }

  if (!testEmail && corporateCases.length > 0 && failed === 0) {
    await supabase
      .from("editorial_drafts")
      .update({ status: "published", updated_at: new Date().toISOString() })
      .in("id", corporateCases.map((item) => item.id));
  }

  await supabase.from("digests").update({ sent, failed }).eq("id", digestId);

  return json({ digestId, format, category, recipients: subscribers.length, daily: dailyArticles.length, corporate: corporateCases.length, sent, failed, test: Boolean(testEmail), provider: provider ?? "default" });
});

function normalizeFormat(value: unknown): DigestFormat | null {
  const format = String(value || "").trim();
  return format in FORMATS ? format as DigestFormat : null;
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

function digestContentIds(dailyArticles: DailyArticle[], corporateCases: CorporateCase[]): string[] {
  return [...new Set([
    ...dailyArticles.map((article) => article.id),
    ...corporateCases.map((item) => item.id),
  ])];
}

// Exactly the QA-selected approved articles, in selection order. No padding.
async function resolveSelectedArticles(supabase: any, articleIds: string[], limit: number, category = ""): Promise<DailyArticle[]> {
  if (articleIds.length === 0) return [];
  const { data, error } = await supabase
    .from("articles")
    .select("id,title,edited_title,summary,edited_summary,url,source,topic,category,rank_score,scraped_at,reviewed_at")
    .in("id", articleIds)
    .eq("status", "approved");
  if (error) throw new Error(error.message);
  const byId = new Map(((data ?? []) as DailyArticle[]).map((article) => [article.id, article]));
  const normalizedCategory = normalizeTopicSlug(category);
  return articleIds
    .map((id) => byId.get(id))
    .filter((article): article is DailyArticle => Boolean(article))
    .filter((article) => isFresh(article.reviewed_at ?? article.scraped_at))
    .filter((article) => normalizedCategory === "daily-wrap"
      ? article.category == null
      : !category || (normalizeTopicSlug(article.category ?? "") === normalizedCategory
        && matchesCategoryContent(category, article.edited_title || article.title, article.edited_summary || article.summary || "")))
    .slice(0, limit);
}

function mapDraftToCase(d: Record<string, any>): CorporateCase {
  return {
    id: d.id,
    headline: d.headline ?? d.topic_name ?? "",
    summary: d.summary ?? "",
    detail: d.detail ?? "",
    source_url: d.primary_source_url ?? "",
    source: d.primary_source_title ?? null,
    generated_at: d.generated_at,
  };
}

const DRAFT_SELECT = "id,topic_slug,topic_name,headline,summary,detail,primary_source_url,primary_source_title,generated_at";

async function resolveCorporateCases(supabase: any, input: { limit: number; corporateCaseId: string }): Promise<CorporateCase[]> {
  // Never silently replace a missing QA selection with another case study.
  if (!input.corporateCaseId) return [];
  const selected = await fetchSelectedCorporateCase(supabase, input.corporateCaseId);
  return selected.slice(0, input.limit);
}

async function fetchSelectedCorporateCase(supabase: any, id: string): Promise<CorporateCase[]> {
  const { data, error } = await supabase
    .from("editorial_drafts")
    .select(DRAFT_SELECT)
    .eq("id", id)
    .eq("status", "approved");
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapDraftToCase);
}

function normalizeTopicSlug(value = ""): string {
  const slug = String(value).trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["daily", "shortly", "shortly-daily-wrap"].includes(slug)) return "daily-wrap";
  if (["realestate", "property"].includes(slug)) return "real-estate";
  if (["auto", "cars", "automotive"].includes(slug)) return "automobile";
  if (["wellness", "health", "wellness-daily"].includes(slug)) return "health-wellness";
  if (["tech", "technology", "ai"].includes(slug)) return "tech-ai";
  if (["money", "finance", "money-matters", "markets", "startups"].includes(slug)) return "markets-startups";
  return slug;
}

async function loadSubscribers(supabase: any, format: DigestFormat, subscriberIds: string[], category = ""): Promise<Subscriber[]> {
  const audienceTopic = normalizeTopicSlug(category);
  let query = supabase
    .from("subscribers")
    .select("id,email,full_name,topics")
    .eq("status", "subscribed");
  if (format === "case-study-only") {
    query = query.overlaps("topics", ["real-estate", "automobile", "health-wellness", "tech-ai", "markets-startups"]);
  } else if (format === "category-5-case-1") {
    query = query.contains("topics", [audienceTopic]);
  } else {
    query = query.contains("topics", ["daily-wrap"]);
  }
  if (subscriberIds.length > 0) {
    query = query.in("id", subscriberIds);
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
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 22px"><tr><td style="background:${bg};color:#ffffff;padding:8px 24px;font-size:17px;line-height:1.25;font-weight:800;letter-spacing:-0.02em;font-family:'Roboto Serif',Georgia,serif">${escapeHtml(text)}</td></tr></table>`;
}

function renderTopMeta(): string {
  const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#3979ff"><tr><td style="padding:8px 24px;color:#ffffff;font:12px/22px Roboto,Arial,sans-serif;letter-spacing:.02em">From the Dailymattr Team</td><td style="padding:8px 24px;color:#ffffff;font:12px/22px Roboto,Arial,sans-serif;text-align:right">${today}</td></tr></table>`;
}

function renderHero(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#3979ff"><tr><td><img src="${BANNER_URL}" alt="Dailymattr - Stories that matter" width="1280" style="display:block;width:100%;height:auto;border:0" /></td></tr></table>`;
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

function renderSection(label: string, items: Array<{ headline: string; body: string; category?: string; sourceCount?: string }>, color = "#111111"): string {
  if (items.length === 0) return "";
  return `${renderLabelBar(label, color)}
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      ${renderRealCards(items)}
    </table>`;
}

function renderRealCards(items: Array<{ headline: string; body: string; category?: string; sourceCount?: string }>): string {
  return items.map((item) => `<tr><td style="padding:0 0 16px"><div style="background:#f5f5f5;border:1px solid #e1e1e1;border-radius:10px;padding:16px 12px 14px">
    <h2 style="font-size:16px;line-height:1.32;margin:0 0 10px;color:#222222;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${escapeHtml(item.headline)}</h2>
    <p style="font-size:12px;line-height:1.2;margin:0 0 14px;color:#666666;font-family:Roboto,Arial,sans-serif">${escapeHtml(item.category || "General")}</p>
    <p style="font-size:13px;line-height:1.55;color:#686868;margin:0 0 12px;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${escapeHtml(item.body)}</p>
    ${item.sourceCount ? `<p style="font-size:11px;line-height:1.3;color:#777777;margin:0;font-family:Roboto,Arial,sans-serif">${item.sourceCount}</p>` : ""}
  </div></td></tr>`).join("");
}

function renderCaseStudies(items: CorporateCase[]): string {
  if (items.length === 0) return "";
  return `${renderLabelBar("Long Mattr. Case Study", "#1c1c1e")}
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td>
      ${items.map((item) => `
        <div style="background:#1c1c1e;border-radius:12px;padding:24px;margin:0 0 22px;color:#ffffff">
          <h2 style="font-size:22px;line-height:1.36;margin:0 0 14px;font-weight:700;font-family:'Roboto Serif',Georgia,serif">${escapeHtml(item.headline)}</h2>
          <p style="font-size:16px;line-height:1.56;margin:0 0 16px;font-family:'Roboto Serif',Georgia,serif">${escapeHtml(item.summary)}</p>
          ${(item.detail || "").split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean).map((paragraph) => `<p style="font-size:16px;line-height:1.56;margin:0 0 14px;font-family:'Roboto Serif',Georgia,serif">${escapeHtml(paragraph)}</p>`).join("")}
          ${item.source_url ? `<p style="font:12px/1.5 Roboto,Arial,sans-serif;margin:14px 0 0"><a href="${escapeHtml(item.source_url)}" style="color:#ffffff;text-decoration:underline">Read the source${item.source ? ` - ${escapeHtml(item.source)}` : ""}</a></p>` : ""}
        </div>`).join("")}
    </td></tr></table>`;
}

async function renderDigest(input: {
  format: DigestFormat;
  category: string;
  dailyArticles: DailyArticle[];
  corporateCases: CorporateCase[];
  subscriber: Subscriber;
}): Promise<string> {
  const greeting = input.subscriber.full_name ? `Hi ${escapeHtml(input.subscriber.full_name)},` : "Hi there,";
  const shareUrl = SITE_URL ? `${SITE_URL}/subscribe.html?utm_source=email&utm_medium=share&utm_campaign=subscribe` : "";
  const shareMessage = "Click here to subscribe to Dailymattr:";
  const twitterUrl = shareUrl
    ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}&url=${encodeURIComponent(shareUrl)}`
    : `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}`;
  const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl || BANNER_URL)}`;
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${shareMessage} ${shareUrl}`.trim())}`;
  const privacyFooter = await renderPrivacyFooter(input.subscriber.email);

  const intro = input.format === "daily-wrap-10"
    ? "Here are 5 things that deserve your attention. The biggest stories, minus the noise. Grab your coffee - you'll be caught up Dailymattr!"
    : input.format === "category-5-case-1"
      ? `Here are 5 stories from ${escapeHtml(input.category)}. The biggest updates from this bucket, minus the noise.`
      : "Here is today's Dailymattr case study, designed as one focused long-form read.";

  const dailyCards = input.dailyArticles.map((article) => ({
    headline: article.edited_title || article.title,
    body: article.edited_summary || article.summary || "",
    category: input.category || article.category || "General",
    sourceCount: article.url
      ? `<a href="${escapeHtml(article.url)}" style="color:#555555;text-decoration:none;margin-right:8px">${escapeHtml(article.source || "Read source")}</a>`
      : escapeHtml(article.source || "")
  }));
  const dailyLabel = input.format === "category-5-case-1" && input.category
    ? `Quick Hits. ${input.category}`
    : "Quick Hits. General";

  return `
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;800&family=Roboto+Serif:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <div style="margin:0;background:#ffffff;padding:0;font-family:Roboto,Arial,sans-serif;color:#191919">
    <div style="max-width:640px;margin:0 auto">
      ${renderTopMeta()}
      ${renderHero()}
      <div style="background:#ffffff;padding:24px;margin:0 0 22px;border-bottom:1px solid #d1d1d1">
        <p style="margin:0 0 12px;color:#191919;font-size:18px;line-height:1.3;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${greeting}</p>
        <p style="margin:0;color:#2f2f39;font-size:16px;line-height:1.7;font-weight:400;font-family:Roboto,Arial,sans-serif">${intro}</p>
      </div>
      ${renderSection(dailyLabel, dailyCards, "#111111")}
      ${renderCaseStudies(input.corporateCases)}
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="display:none;margin-top:4px;margin-bottom:20px">
        <tr><td style="text-align:center;padding:10px 20px 14px">
          <div style="margin:0 auto 8px;color:#111111;font:700 24px/1 'Roboto Serif',Georgia,serif">Dailymattr<sup style="font-size:10px">Â®</sup></div>
          <p style="margin:0 0 10px;color:#9a9ab0;font-size:12px;line-height:1.5;font-family:Roboto,Arial,sans-serif">Curated news, summarized daily.<br>You're receiving this because you subscribed to Dailymattr.</p>
          <div style="text-align:center">
            <a href="${twitterUrl}" style="display:inline-block;margin:0 8px;color:#111111;font-size:12px;font-family:Roboto,Arial,sans-serif">X</a>
            <a href="${linkedinUrl}" style="display:inline-block;margin:0 8px;color:#111111;font-size:12px;font-family:Roboto,Arial,sans-serif">LinkedIn</a>
            <a href="${whatsappUrl}" style="display:inline-block;margin:0 8px;color:#111111;font-size:12px;font-family:Roboto,Arial,sans-serif">WhatsApp</a>
          </div>
          ${privacyFooter}
        </td></tr>
      </table>
      ${renderFooterBrand()}${normalizeStoreLinks(renderFooter("https://longmattr.com/", twitterUrl, linkedinUrl, privacyFooter))}
    </div>
  </div>`;
}
