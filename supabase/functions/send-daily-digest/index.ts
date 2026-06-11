// send-daily-digest: Single-section newsletter with fallback auto-select.
// Sends 10 stories in one "Shortly Wrapped" section.
// Guarantees at least 1 finance/business article when possible.
// Fallback: if QA hasn't approved enough, auto-selects from summarized pool.

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
  rank_score: number;
};

type Subscriber = { id: string; email: string; full_name: string | null };

const TOTAL_ARTICLES = 10;
const FINANCE_TOPICS = ["business", "india business", "finance", "economy", "markets"];
const BANNER_URL =
  Deno.env.get("SHORTLY_BANNER_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/email-banner.jpg";
const FOOTER_LOGO_URL =
  Deno.env.get("SHORTLY_FOOTER_LOGO_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/footer-logo.png";
const SITE_URL = (Deno.env.get("SHORTLY_SITE_URL") ?? "").replace(/\/+$/, "");
const AUTO_DIGEST_ENABLED = (Deno.env.get("SHORTLY_AUTO_DIGEST_ENABLED") ?? "false").toLowerCase() === "true";

function escapeHtmlText(value = ""): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isFinance(a: Article): boolean {
  return FINANCE_TOPICS.includes((a.topic ?? "").toLowerCase());
}

function normalizeWrapped(articles: Article[]): Article[] {
  const wrapped = articles.slice(0, TOTAL_ARTICLES);
  if (wrapped.some(isFinance)) return wrapped;

  const spare = articles.find((a) => isFinance(a) && !wrapped.some((used) => used.id === a.id));
  if (spare && wrapped.length > 0) {
    wrapped[wrapped.length - 1] = spare;
  }
  return wrapped;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  let subscriberIds: string[] = [];
  let articleIds: string[] = [];
  let isManual = false;
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    subscriberIds = Array.isArray(body?.subscriber_ids)
      ? body.subscriber_ids.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    articleIds = Array.isArray(body?.article_ids)
      ? body.article_ids.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    isManual = body?.manual === true;
  }

  if (!isManual && !AUTO_DIGEST_ENABLED) {
    return json({ error: "Automatic digest sending is turned off for now." }, 403);
  }

  let articles: Article[] = [];
  let autoSelected = false;

  if (articleIds.length > 0) {
    const { data: selectedArticles, error: selectedError } = await supabase
      .from("articles")
      .select("id,title,edited_title,url,summary,edited_summary,source,topic,section,rank_score")
      .in("id", articleIds);

    if (selectedError) return json({ error: selectedError.message }, 500);
    const byId = new Map(((selectedArticles ?? []) as Article[]).map((article) => [article.id, article]));
    articles = articleIds.map((id) => byId.get(id)).filter((article): article is Article => Boolean(article));
  } else {
    // 1. Try approved articles first
    const { data: approved, error: approvedError } = await supabase
      .from("articles")
      .select("id,title,edited_title,url,summary,edited_summary,source,topic,section,rank_score")
      .eq("status", "approved")
      .order("rank_score", { ascending: false })
      .order("scraped_at", { ascending: false })
      .limit(20);

    if (approvedError) return json({ error: approvedError.message }, 500);
    articles = (approved ?? []) as Article[];
  }

  // 2. FALLBACK: If QA didn't approve enough, auto-select from summarized
  if (articleIds.length === 0 && articles.length < TOTAL_ARTICLES) {
    const need = TOTAL_ARTICLES - articles.length;
    const usedIds = articles.map((a) => a.id);

    const { data: fallback } = await supabase
      .from("articles")
      .select("id,title,edited_title,url,summary,edited_summary,source,topic,section,rank_score")
      .eq("status", "summarized")
      .order("rank_score", { ascending: false })
      .order("scraped_at", { ascending: false })
      .limit(need + 10); // grab extra for finance guarantee

    const extras = ((fallback ?? []) as Article[]).filter((a) => !usedIds.includes(a.id));
    articles = [...articles, ...extras].slice(0, TOTAL_ARTICLES);
    autoSelected = extras.length > 0;

    // Auto-approve the fallback articles
    if (extras.length > 0) {
      const extraIds = extras.map((a) => a.id).slice(0, need);
      await supabase
        .from("articles")
        .update({ status: "approved", reviewed_at: new Date().toISOString(), reviewed_by: "auto-fallback" })
        .in("id", extraIds);
    }
  }

  if (articles.length === 0) return json({ error: "No selected articles available to send" }, 400);

  // Cap at 10 and keep a single wrapped section
  const wrapped = normalizeWrapped(articles);
  const allArticles = wrapped;

  // 3. Subscribers
  let subQuery = supabase
    .from("subscribers")
    .select("id,email,full_name")
    .eq("status", "subscribed");
  if (subscriberIds.length > 0) {
    subQuery = subQuery.in("id", subscriberIds);
  }
  const { data: subs, error: subError } = await subQuery;
  if (subError) return json({ error: subError.message }, 500);
  const subscribers = (subs ?? []) as Subscriber[];
  if (subscribers.length === 0) return json({ error: "No subscribers" }, 400);

  // 4. Create digest log
  const { data: digest, error: digestError } = await supabase
    .from("digests")
    .insert({ article_ids: allArticles.map((a) => a.id), recipients: subscribers.length })
    .select("id")
    .single();
  if (digestError) return json({ error: digestError.message }, 500);
  const digestId = digest!.id as string;

  const subjectDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const subject = `${subjectDate} - Shortly Daily Wrap is here!`;

  // 5. Send to subscribers in small batches to avoid long sequential runs.
  let sent = 0;
  let failed = 0;
  const batchSize = 5;

  for (let i = 0; i < subscribers.length; i += batchSize) {
    const batch = subscribers.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (sub) => {
      const html = renderDigest(wrapped, sub);
      const result = await sendEmail({
        to: sub.email,
        subject,
        html,
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

  // 6. Mark articles as sent
  await supabase
    .from("articles")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .in("id", allArticles.map((a) => a.id));

  await supabase.from("digests").update({ sent, failed }).eq("id", digestId);

  return json({
    digestId,
    wrapped: wrapped.length,
    recipients: subscribers.length,
    sent,
    failed,
    autoSelected,
  });
});

// ── Helpers ──

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
                <div style="width:36px;height:36px;border-radius:50%;background:#efe7ff;color:#6d28d9;border:2px solid #6d28d9;font-size:15px;font-weight:700;text-align:center;line-height:32px">
                  ${i + 1}
                </div>
              </td>
              <td style="padding-left:14px">
                <h2 style="font-size:18px;line-height:1.28;margin:0 0 10px;color:#191919;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">
                  ${escapeHtml(headline)}
                </h2>
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

function renderSectionBlock(title: string, subtitle: string, articles: Article[]): string {
  if (articles.length === 0) return "";
  return `
      ${renderLabelBar("Quick Hits. Daily Wrap", "#6d28d9")}
      <div style="margin-bottom:22px;border-radius:22px;background:transparent">
        <div style="padding:0">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            ${renderItems(articles)}
          </table>
        </div>
      </div>`;
}

function renderDigest(wrapped: Article[], sub: Subscriber): string {
  const greeting = sub.full_name ? `Hi ${escapeHtml(sub.full_name)},` : "Hi there,";
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // Read time estimate
  wrapped.reduce((sum, a) => {
    const text = (a.edited_summary || a.summary || "").trim();
    return sum + text.split(/\s+/).filter(Boolean).length;
  }, 0);

  // Social sharing
  const shareUrl = SITE_URL ? `${SITE_URL}/subscribe.html?utm_source=email&utm_medium=share&utm_campaign=subscribe` : "";
  const shareMessage = "Click here to subscribe to Shortly Daily Wrap:";
  const twitterUrl = shareUrl
    ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}&url=${encodeURIComponent(shareUrl)}`
    : `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}`;
  const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl || BANNER_URL)}`;
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${shareMessage} ${shareUrl}`.trim())}`;
  const xIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18.901 2H21.98l-6.73 7.693L23.167 22h-6.197l-4.85-7.356L5.68 22H2.6l7.2-8.23L1.5 2h6.355l4.384 6.689L18.901 2Zm-1.087 18.145h1.706L6.93 3.759H5.1l12.714 16.386Z" fill="#6d28d9"/></svg>`;
  const linkedinIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6.94 8.5H3.56V20h3.38V8.5Zm.22-3.56C7.15 3.77 6.3 3 5.26 3S3.38 3.77 3.38 4.94s.83 1.94 1.85 1.94h.03c1.06 0 1.9-.77 1.9-1.94ZM20.62 12.65c0-3.46-1.85-5.07-4.32-5.07-1.99 0-2.88 1.1-3.37 1.87V8.5H9.55c.04.63 0 11.5 0 11.5h3.38v-6.42c0-.34.02-.68.12-.92.27-.68.88-1.39 1.9-1.39 1.34 0 1.88 1.02 1.88 2.52V20H20.2v-6.35Z" fill="#6d28d9"/></svg>`;
  const whatsappIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20.52 3.48A11.86 11.86 0 0 0 12.07 0C5.51 0 .18 5.33.18 11.88c0 2.1.55 4.16 1.58 5.97L0 24l6.33-1.66a11.86 11.86 0 0 0 5.74 1.47h.01c6.55 0 11.88-5.33 11.88-11.88 0-3.17-1.24-6.14-3.44-8.45Zm-8.45 18.3h-.01a9.94 9.94 0 0 1-5.07-1.39l-.36-.21-3.76.99 1-3.66-.23-.37a9.9 9.9 0 0 1-1.53-5.26c0-5.47 4.45-9.92 9.93-9.92 2.65 0 5.14 1.03 7.01 2.9a9.85 9.85 0 0 1 2.9 7.02c0 5.47-4.45 9.92-9.91 9.92Zm5.44-7.42c-.3-.15-1.8-.89-2.08-.99-.28-.1-.48-.15-.69.15-.2.3-.79.99-.96 1.19-.18.2-.35.23-.65.08-.3-.15-1.27-.47-2.42-1.5a9 9 0 0 1-1.67-2.07c-.18-.3-.02-.46.13-.61.13-.13.3-.35.45-.53.15-.18.2-.3.3-.5.1-.2.05-.38-.02-.53-.08-.15-.69-1.66-.94-2.28-.25-.6-.5-.52-.69-.53h-.58c-.2 0-.53.08-.81.38-.28.3-1.06 1.03-1.06 2.5s1.09 2.89 1.24 3.1c.15.2 2.14 3.26 5.18 4.57.72.31 1.29.5 1.73.64.73.23 1.39.2 1.92.12.59-.09 1.8-.74 2.05-1.45.25-.71.25-1.32.17-1.45-.08-.13-.28-.2-.58-.35Z" fill="#6d28d9"/></svg>`;

  return `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;800&family=Roboto+Serif:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <div style="margin:0;background:#fcfbf7;padding:0;font-family:Roboto,Arial,sans-serif;color:#191919">
    <div style="max-width:640px;margin:0 auto">

      <img src="${BANNER_URL}" alt="Shortly Daily Wrap" width="640" style="display:block;width:100%;max-width:640px;height:auto;border-radius:0 0 16px 16px">

      ${renderLabelBar("From the Shortly Team", "#0f9d69")}
      <div style="background:#ffffff;border-radius:12px;padding:26px 28px;margin:0 0 24px;border:3px solid #111111">
        <p style="margin:0 0 12px;color:#191919;font-size:18px;line-height:1.3;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">
          ${greeting}
        </p>
        <p style="margin:0;color:#2f2f39;font-size:16px;line-height:1.7;font-weight:400;font-family:Roboto,Arial,sans-serif">
          Here are 10 things that deserve your attention. The biggest stories, minus the noise. Grab your coffee &mdash; you'll be caught up SHORTLY!
        </p>
      </div>

      ${renderSectionBlock("Shortly Wrapped", `${wrapped.length} stories to catch up on`, wrapped)}

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:4px;margin-bottom:20px">
        <tr><td style="text-align:center;padding:10px 20px 14px">
          <img src="${FOOTER_LOGO_URL}" alt="Shortly" width="96" style="display:block;width:96px;max-width:100%;height:auto;margin:0 auto 8px">
          <p style="margin:0 0 10px;color:#9a9ab0;font-size:12px;line-height:1.5;font-family:Roboto,Arial,sans-serif">
            Curated news, summarized daily.<br>
            You're receiving this because you subscribed to Shortly.
          </p>
            <p style="margin:0 0 8px;font-size:12px;color:#9a9ab0;font-family:Roboto,Arial,sans-serif">Can be forwarded to others.</p>
            <div style="text-align:center">
              <a href="${twitterUrl}" style="display:inline-block;margin:0 6px;text-decoration:none;vertical-align:middle">${xIcon}</a>
              <a href="${linkedinUrl}" style="display:inline-block;margin:0 6px;text-decoration:none;vertical-align:middle">${linkedinIcon}</a>
              <a href="${whatsappUrl}" style="display:inline-block;margin:0 6px;text-decoration:none;vertical-align:middle">${whatsappIcon}</a>
            </div>
        </td></tr>
      </table>

    </div>
  </div>`;
}
