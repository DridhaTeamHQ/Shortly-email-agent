// send-daily-digest: sends EXACTLY the articles QA selected (or, if none were
// selected, exactly the articles QA already approved today). No auto-fill,
// no auto-approve, no finance swap. Stale (old) selected articles are dropped,
// and duplicate sends are guarded.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { sendEmail } from "../_shared/mailer.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { renderPrivacyFooter } from "../_shared/privacy.ts";

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

const TOTAL_ARTICLES = 5;
// Selected articles older than this are treated as stale and dropped, so a
// leftover old selection can never resurface as a "June 17 on June 20" email.
const FRESH_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const ARTICLE_SELECT =
  "id,title,edited_title,url,summary,edited_summary,source,topic,section,status,rank_score,scraped_at,reviewed_at";
const BANNER_URL =
  Deno.env.get("SHORTLY_BANNER_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/figma-email-banner.png";
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
  // Server-side auth: service_role JWT (cron) or the dashboard's agent token.
  const denied = await requireAgent(request);
  if (denied) return denied;


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
    const { start: dayStart, end: dayEnd } = istDayWindow();
    const { data: approved, error: approvedError } = await supabase
      .from("articles")
      .select(ARTICLE_SELECT)
      .eq("status", "approved")
      .is("category", null)
      .gte("reviewed_at", dayStart)
      .lt("reviewed_at", dayEnd)
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
  const subject = `${subjectDate} - Daily Mattr Wrap is here!`;

  let sent = 0;
  let failed = 0;
  const batchSize = 5;

  for (let i = 0; i < subscribers.length; i += batchSize) {
    const batch = subscribers.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (sub) => {
      const html = await renderDigest(wrapped, sub);
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

function renderLabelBar(text: string, bg: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 22px"><tr><td style="background:${bg};color:#ffffff;padding:8px 24px;font-size:17px;line-height:1.25;font-weight:800;letter-spacing:-0.02em;font-family:'Roboto Serif',Georgia,serif">${text}</td></tr></table>`;
}

function renderRealItems(articles: Article[]): string {
  return articles.map((article) => `
    <tr><td style="padding:0 0 16px">
      <div style="background:#f5f5f5;border:1px solid #e1e1e1;border-radius:10px;padding:16px 12px 14px">
        <h2 style="font-size:16px;line-height:1.32;margin:0 0 10px;color:#222222;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${escapeHtml(article.edited_title || article.title || "")}</h2>
        <p style="font-size:12px;line-height:1.2;margin:0 0 14px;color:#666666;font-family:Roboto,Arial,sans-serif">General</p>
        <p style="font-size:13px;line-height:1.55;color:#686868;margin:0 0 12px;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${escapeHtml(article.edited_summary || article.summary || "")}</p>
        ${article.url || article.source ? `<p style="font-size:11px;line-height:1.3;color:#777777;margin:0;font-family:Roboto,Arial,sans-serif">${article.url ? `<a href="${escapeHtml(article.url)}" style="color:#555555;text-decoration:none">${escapeHtml(article.source || "Read source")}</a>` : escapeHtml(article.source || "")}</p>` : ""}
      </div>
    </td></tr>`).join("");
}

function renderTopMeta(): string {
  const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#020202"><tr><td style="padding:8px 24px;color:#dadada;font:12px/22px Roboto,Arial,sans-serif">From the Daily Mattr Team</td><td style="padding:8px 24px;color:#dadada;font:12px/22px Roboto,Arial,sans-serif;text-align:right">${today}</td></tr></table>`;
}

function renderHero(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#020202 url('${BANNER_URL}') center/cover no-repeat"><tr><td style="background:rgba(0,0,0,.68);padding:36px 24px 40px;text-align:center;color:#ffffff"><div style="font:700 24px/1 'Roboto Serif',Georgia,serif;margin-bottom:18px">DailyMattr<sup style="font-size:10px">®</sup></div><div style="font:900 54px/.95 Georgia,'Times New Roman',serif;letter-spacing:-.04em">LONG MATTR</div><div style="margin-top:14px;font:700 12px/1.2 Roboto,Arial,sans-serif;letter-spacing:.28em;text-transform:uppercase">Stories that matter</div></td></tr></table>`;
}

function renderFooterBrand(): string {
  return `<div style="text-align:center;padding:24px 20px 8px;background:#fff"><div style="margin:0 0 10px;color:#202020;font:700 24px/1 'Roboto Serif',Georgia,serif">DailyMattr<sup style="font-size:10px">®</sup></div><p style="margin:0 0 8px;color:#70707c;font:16px/1.5 Roboto,Arial,sans-serif">Curated news, summarized daily.<br>You're receiving this because you subscribed to <span style="color:#202020">Daily Mattr</span></p><p style="margin:0;color:#70707c;font:16px/1.5 Roboto,Arial,sans-serif">Can be <u>forwarded</u> to others.</p></div>`;
}

function renderFooter(subscribeUrl: string, twitterUrl: string, linkedinUrl: string, privacyFooter: string): string {
  const icon = (href: string, label: string) => `<a href="${href}" style="display:inline-block;width:28px;height:28px;line-height:28px;margin-right:10px;border-radius:50%;background:#000;color:#fff;text-align:center;text-decoration:none;font:700 14px/28px Arial,sans-serif">${label}</a>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:28px"><tr><td style="padding:18px 28px 14px;background:#fff"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td>${icon("https://www.instagram.com/dailymattr", "◎")}${icon(twitterUrl, "X")}${icon(linkedinUrl, "in")}</td><td style="text-align:right"><a href="${subscribeUrl}" style="display:inline-block;background:#202020;color:#fff;border-radius:24px;padding:12px 20px;text-decoration:none;font:700 15px/1 Roboto,Arial,sans-serif">Subscribe&nbsp; ↗</a></td></tr></table></td></tr><tr><td style="background:#050505;color:#fff;padding:16px 28px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="font:700 15px/1.2 Roboto,Arial,sans-serif">Read from anywhere</td><td style="text-align:right"><a href="#" style="display:inline-block;background:#202020;border:1px solid #333;border-radius:20px;color:#fff;padding:9px 14px;text-decoration:none;font:600 11px/1 Roboto,Arial,sans-serif">▷&nbsp; Google Play</a>&nbsp; <a href="#" style="display:inline-block;background:#202020;border:1px solid #333;border-radius:20px;color:#fff;padding:9px 14px;text-decoration:none;font:600 11px/1 Roboto,Arial,sans-serif">●&nbsp; App Store</a></td></tr></table></td></tr></table>${privacyFooter}`;
}

function normalizeStoreLinks(html: string): string {
  return html.replace('href="#"', 'href="https://play.google.com/store"').replace('href="#"', 'href="https://www.apple.com/app-store/"');
}

function renderSectionBlock(articles: Article[]): string {
  if (articles.length === 0) return "";
  return `
      ${renderLabelBar("Quick Hits. Daily Wrap", "#111111")}
      <div style="margin-bottom:22px;border-radius:22px;background:transparent">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${renderRealItems(articles)}</table>
      </div>`;
}

async function renderDigest(wrapped: Article[], sub: Subscriber): Promise<string> {
  const greeting = sub.full_name ? `Hi ${escapeHtml(sub.full_name)},` : "Hi there,";

  const shareUrl = SITE_URL ? `${SITE_URL}/subscribe.html?utm_source=email&utm_medium=share&utm_campaign=subscribe` : "";
  const shareMessage = "Click here to subscribe to Daily Mattr:";
  const twitterUrl = shareUrl
    ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}&url=${encodeURIComponent(shareUrl)}`
    : `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}`;
  const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl || BANNER_URL)}`;
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${shareMessage} ${shareUrl}`.trim())}`;
  const privacyFooter = await renderPrivacyFooter(sub.email);

  return `
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;800&family=Roboto+Serif:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <div style="margin:0;background:#ffffff;padding:0;font-family:Roboto,Arial,sans-serif;color:#191919">
    <div style="max-width:640px;margin:0 auto">
      ${renderTopMeta()}
      ${renderHero()}
      <div style="background:#ffffff;padding:24px;margin:0 0 22px;border-bottom:1px solid #d1d1d1">
        <p style="margin:0 0 12px;color:#191919;font-size:18px;line-height:1.3;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${greeting}</p>
        <p style="margin:0;color:#2f2f39;font-size:16px;line-height:1.7;font-weight:400;font-family:Roboto,Arial,sans-serif">Here are the stories that deserve your attention. The biggest news, minus the noise. Grab your coffee &mdash; you'll be caught up Daily Mattr!</p>
      </div>

      ${renderSectionBlock(wrapped)}

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="display:none;margin-top:4px;margin-bottom:20px">
        <tr><td style="text-align:center;padding:10px 20px 14px">
          <div style="margin:0 auto 8px;color:#111111;font:700 24px/1 'Roboto Serif',Georgia,serif">DailyMattr<sup style="font-size:10px">®</sup></div>
          <p style="margin:0 0 10px;color:#9a9ab0;font-size:12px;line-height:1.5;font-family:Roboto,Arial,sans-serif">Curated news, summarized daily.<br>You're receiving this because you subscribed to Daily Mattr.</p>
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
