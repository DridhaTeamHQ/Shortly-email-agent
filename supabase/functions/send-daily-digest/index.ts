// send-daily-digest: sends EXACTLY the articles QA selected (or, if none were
// selected, exactly the articles QA already approved today). No auto-fill,
// no auto-approve, no finance swap. Stale (old) selected articles are dropped,
// and duplicate sends are guarded.

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
  section: string | null;
  status: string;
  rank_score: number;
  scraped_at: string;
  reviewed_at: string | null;
};

type Subscriber = { id: string; email: string; full_name: string | null; topics?: string[] | null };

const TOTAL_ARTICLES = 10;
// Selected articles older than this are treated as stale and dropped, so a
// leftover old selection can never resurface as a "June 17 on June 20" email.
const FRESH_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const ARTICLE_SELECT =
  "id,title,edited_title,url,summary,edited_summary,source,topic,section,status,rank_score,scraped_at,reviewed_at";
const BANNER_URL =
  Deno.env.get("SHORTLY_BANNER_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/email-banner.jpg";
const FOOTER_LOGO_URL =
  Deno.env.get("SHORTLY_FOOTER_LOGO_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/footer-logo.png";
const SITE_URL = (Deno.env.get("SHORTLY_SITE_URL") ?? "").replace(/\/+$/, "");
const AUTO_DIGEST_ENABLED = (Deno.env.get("SHORTLY_AUTO_DIGEST_ENABLED") ?? "false").toLowerCase() === "true";

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

function isFresh(scrapedAt: string): boolean {
  const t = new Date(scrapedAt).getTime();
  return Number.isFinite(t) && (Date.now() - t) <= FRESH_WINDOW_MS;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  let subscriberIds: string[] = [];
  let articleIds: string[] = [];
  let isManual = false;
  let isScheduled = false;
  let forceSend = false;
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    subscriberIds = Array.isArray(body?.subscriber_ids)
      ? body.subscriber_ids.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    articleIds = Array.isArray(body?.article_ids)
      ? body.article_ids.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    isManual = body?.manual === true;
    isScheduled = body?.scheduled === true;
    forceSend = body?.force === true;
  }

  if (!isManual && !isScheduled && !AUTO_DIGEST_ENABLED) {
    return json({ error: "Automatic digest sending is turned off for now." }, 403);
  }

  // Universal duplicate guard: skip if a real digest was already sent in the last
  // 2 minutes. Stops concurrent cron retries and manual double-clicks from blasting
  // subscribers with duplicate copies.
  if (!forceSend) {
    const recentCutoff = new Date(Date.now() - 120 * 1000).toISOString();
    const { data: recent } = await supabase
      .from("digests")
      .select("id")
      .gt("recipients", 0)
      .gte("sent_at", recentCutoff)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recent) return json({ skipped: true, reason: "A digest was already sent in the last 2 minutes.", digestId: recent.id });
  }

  // For scheduled sends, also enforce one per IST day.
  if (isScheduled && !forceSend) {
    const { start: istStart, end: istEnd } = istDayWindow();
    const { data: existingDigest } = await supabase
      .from("digests")
      .select("id,sent_at")
      .gte("sent_at", istStart)
      .lt("sent_at", istEnd)
      .gt("recipients", 0)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingDigest) {
      return json({ skipped: true, reason: "Scheduled digest already ran for the current IST day.", digestId: existingDigest.id });
    }
  }

  let articles: Article[] = [];
  let ignoredOldSelected = 0;

  if (articleIds.length > 0) {
    const { data: selectedArticles, error: selectedError } = await supabase
      .from("articles")
      .select(ARTICLE_SELECT)
      .in("id", articleIds);

    if (selectedError) return json({ error: selectedError.message }, 500);
    const byId = new Map(((selectedArticles ?? []) as Article[]).map((article) => [article.id, article]));
    const orderedSelected = articleIds
      .map((id) => byId.get(id))
      .filter((article): article is Article => Boolean(article));
    // Exactly what QA selected, but drop anything not approved or gone stale.
    articles = orderedSelected.filter((article) => article.status === "approved" && isFresh(article.reviewed_at ?? article.scraped_at));
    ignoredOldSelected = orderedSelected.length - articles.length;
  } else {
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const { data: approved, error: approvedError } = await supabase
      .from("articles")
      .select(ARTICLE_SELECT)
      .eq("status", "approved")
      .is("category", null)
      .gte("reviewed_at", dayStart)
      .order("rank_score", { ascending: false })
      .order("scraped_at", { ascending: false })
      .limit(TOTAL_ARTICLES);

    if (approvedError) return json({ error: approvedError.message }, 500);
    articles = (approved ?? []) as Article[];
  }

  // No auto-fill, no auto-approve, no finance swap. Exactly what QA selected/approved.
  if (articles.length === 0) return json({ error: "No selected articles available to send", ignoredOldSelected }, 400);

  const wrapped = articleIds.length > 0 ? articles : articles.slice(0, TOTAL_ARTICLES);
  const allArticles = wrapped;

  let subQuery = supabase
    .from("subscribers")
    .select("id,email,full_name,topics")
    .eq("status", "subscribed");
  if (subscriberIds.length > 0) {
    subQuery = subQuery.in("id", subscriberIds);
  } else {
    subQuery = subQuery.contains("topics", ["daily-wrap"]);
  }
  const { data: subs, error: subError } = await subQuery;
  if (subError) return json({ error: subError.message }, 500);
  const subscribers = (subs ?? []) as Subscriber[];
  if (subscribers.length === 0) return json({ error: "No subscribers" }, 400);

  const { data: digest, error: digestError } = await supabase
    .from("digests")
    .insert({ article_ids: allArticles.map((a) => a.id), recipients: subscribers.length })
    .select("id")
    .single();
  if (digestError) return json({ error: digestError.message }, 500);
  const digestId = digest!.id as string;

  const subjectDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const subject = `${subjectDate} - Shortly Daily Wrap is here!`;

  let sent = 0;
  let failed = 0;
  const batchSize = 5;

  for (let i = 0; i < subscribers.length; i += batchSize) {
    const batch = subscribers.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (sub) => {
      const html = renderDigest(wrapped, sub);
      const result = await sendEmail({ to: sub.email, subject, html });
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

  await supabase
    .from("articles")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .in("id", allArticles.map((a) => a.id));

  await supabase.from("digests").update({ sent, failed }).eq("id", digestId);

  return json({ digestId, wrapped: wrapped.length, recipients: subscribers.length, sent, failed, ignoredOldSelected });
});

function escapeHtml(v = "") {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderItems(articles: Article[]): string {
  return articles
    .map((a, i) => {
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
    })
    .join("");
}

function renderLabelBar(text: string, bg: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px;padding:0 10px"><tr>
      <td style="width:220px">
        <div style="background:${bg};color:#ffffff;border:3px solid #111111;font-size:14px;font-weight:800;letter-spacing:0.02em;text-transform:uppercase;text-align:center;padding:4px 12px;font-family:Roboto,Arial,sans-serif">${text}</div>
      </td>
      <td style="border-bottom:3px solid #111111">&nbsp;</td>
    </tr></table>`;
}

function renderSectionBlock(articles: Article[]): string {
  if (articles.length === 0) return "";
  return `
      ${renderLabelBar("Quick Hits. Daily Wrap", "#6d28d9")}
      <div style="margin-bottom:22px;border-radius:22px;background:transparent">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${renderItems(articles)}</table>
      </div>`;
}

function renderDigest(wrapped: Article[], sub: Subscriber): string {
  const greeting = sub.full_name ? `Hi ${escapeHtml(sub.full_name)},` : "Hi there,";

  const shareUrl = SITE_URL ? `${SITE_URL}/subscribe.html?utm_source=email&utm_medium=share&utm_campaign=subscribe` : "";
  const shareMessage = "Click here to subscribe to Shortly Daily Wrap:";
  const twitterUrl = shareUrl
    ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}&url=${encodeURIComponent(shareUrl)}`
    : `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}`;
  const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl || BANNER_URL)}`;
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${shareMessage} ${shareUrl}`.trim())}`;

  return `
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;800&family=Roboto+Serif:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <div style="margin:0;background:#fcfbf7;padding:0;font-family:Roboto,Arial,sans-serif;color:#191919">
    <div style="max-width:640px;margin:0 auto">
      <img src="${BANNER_URL}" alt="Shortly Daily Wrap" width="640" style="display:block;width:100%;max-width:640px;height:auto;border-radius:0 0 16px 16px">

      ${renderLabelBar("From the Shortly Team", "#0f9d69")}
      <div style="background:#ffffff;border-radius:12px;padding:26px 28px;margin:0 0 24px;border:3px solid #111111">
        <p style="margin:0 0 12px;color:#191919;font-size:18px;line-height:1.3;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${greeting}</p>
        <p style="margin:0;color:#2f2f39;font-size:16px;line-height:1.7;font-weight:400;font-family:Roboto,Arial,sans-serif">Here are the stories that deserve your attention. The biggest news, minus the noise. Grab your coffee &mdash; you'll be caught up SHORTLY!</p>
      </div>

      ${renderSectionBlock(wrapped)}

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
