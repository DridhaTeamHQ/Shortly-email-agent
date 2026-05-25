// send-daily-digest: Single-section newsletter with fallback auto-select.
// Sends 10 stories in one "Shortly Wrapped" section.
// Guarantees at least 1 finance/business article when possible.
// Fallback: if QA hasn't approved enough, auto-selects from summarized pool.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { sendEmail } from "../_shared/mailer.ts";
import { generateUnsubToken } from "../_shared/unsub.ts";

type Article = {
  id: string;
  title: string;
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
// Hosted banner (public Supabase Storage). Gmail strips base64 data: URIs, so we
// reference the hosted image instead of inlining it.
const BANNER_URL = "https://ygxdrphajvrbjcaxhvcn.supabase.co/storage/v1/object/public/assets/banner.jpeg";

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

  // 1. Try approved articles first
  const { data: approved, error: approvedError } = await supabase
    .from("articles")
    .select("id,title,url,summary,edited_summary,source,topic,section,rank_score")
    .eq("status", "approved")
    .order("rank_score", { ascending: false })
    .order("scraped_at", { ascending: false })
    .limit(20);

  if (approvedError) return json({ error: approvedError.message }, 500);
  let articles = (approved ?? []) as Article[];
  let autoSelected = false;

  // 2. FALLBACK: If QA didn't approve enough, auto-select from summarized
  if (articles.length < TOTAL_ARTICLES) {
    const need = TOTAL_ARTICLES - articles.length;
    const usedIds = articles.map((a) => a.id);

    const { data: fallback } = await supabase
      .from("articles")
      .select("id,title,url,summary,edited_summary,source,topic,section,rank_score")
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

  if (articles.length === 0) return json({ error: "No articles available to send" }, 400);

  // Cap at 10 and keep a single wrapped section
  const wrapped = normalizeWrapped(articles);
  const allArticles = wrapped;

  // 3. Subscribers
  const { data: subs, error: subError } = await supabase
    .from("subscribers")
    .select("id,email,full_name")
    .eq("status", "subscribed");
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

  const subject = `${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} — Shortly Digest`;

  // 5. Send to each subscriber
  let sent = 0;
  let failed = 0;

  for (const sub of subscribers) {
    const html = await renderDigest(wrapped, sub);
    const result = await sendEmail({
      to: sub.email,
      subject,
      html,
    });
    if (result.ok) sent++;
    else failed++;
    await supabase.from("article_deliveries").insert({
      digest_id: digestId,
      subscriber_id: sub.id,
      email: sub.email,
      status: result.ok ? "sent" : "failed",
      provider_message_id: result.messageId ?? null,
      error: result.error ?? null,
    });
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
      const text = (a.edited_summary || a.summary || "").trim();
      const meta = escapeHtml(a.topic ?? "Top story");
      return `
        <tr><td style="padding:24px 0;${i < articles.length - 1 ? "border-bottom:1px solid #ede7f6;" : ""}">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
            <td style="width:40px;vertical-align:top;padding-top:2px">
              <div style="width:32px;height:32px;border-radius:50%;background:#7c3aed;color:#ffffff;font-size:14px;font-weight:700;text-align:center;line-height:32px">
                ${i + 1}
              </div>
            </td>
            <td style="padding-left:14px">
              <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#7c3aed;font-weight:600;margin-bottom:6px;font-family:Roboto,Arial,sans-serif">
                ${meta}
              </div>
              <h2 style="font-size:18px;line-height:1.35;margin:0 0 10px;color:#1a1a2e;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">
                ${escapeHtml(a.title)}
              </h2>
              <p style="font-size:15px;line-height:1.7;color:#4a4a68;margin:0;font-family:Roboto,Arial,sans-serif">${escapeHtml(text)}</p>
            </td>
          </tr></table>
        </td></tr>`;
    })
    .join("");
}

function renderSectionBlock(title: string, subtitle: string, articles: Article[]): string {
  if (articles.length === 0) return "";
  return `
      <div style="margin-bottom:20px;border-radius:18px;overflow:hidden;background:#ffffff;border:1px solid #e8e0f5">
        <div style="background:linear-gradient(90deg,#7c3aed 0%,#9b5cf6 100%);padding:24px 28px 20px">
          <h2 style="margin:0 0 6px;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;font-family:Roboto,Arial,sans-serif">${escapeHtml(title)}</h2>
          <p style="margin:0;font-size:13px;color:#efe7ff;font-weight:500;font-family:Roboto,Arial,sans-serif">${escapeHtml(subtitle)}</p>
        </div>
        <div style="padding:10px 28px 8px">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            ${renderItems(articles)}
          </table>
        </div>
      </div>`;
}

async function renderDigest(wrapped: Article[], sub: Subscriber): Promise<string> {
  const greeting = sub.full_name ? `Hey ${escapeHtml(sub.full_name)},` : "Hey there,";
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // Read time estimate
  const totalWords = wrapped.reduce((sum, a) => {
    const text = (a.edited_summary || a.summary || "").trim();
    return sum + text.split(/\s+/).filter(Boolean).length;
  }, 0);
  const readTime = Math.max(1, Math.ceil(totalWords / 200));

  // Unsubscribe link
  const secret = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const unsubToken = await generateUnsubToken(sub.email, secret);
  const unsubUrl = `https://ygxdrphajvrbjcaxhvcn.functions.supabase.co/unsubscribe?email=${encodeURIComponent(sub.email)}&token=${encodeURIComponent(unsubToken)}`;

  // Social sharing
  const shareText = encodeURIComponent("Check out Shortly newsletter — curated news, summarized daily.");
  const twitterUrl = `https://twitter.com/intent/tweet?text=${shareText}`;
  const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent("https://shortly.news")}&summary=${shareText}`;
  const whatsappUrl = `https://wa.me/?text=${shareText}`;

  return `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;800&family=Roboto+Serif:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <div style="margin:0;background:#f5f3ff;padding:0;font-family:Roboto,Arial,sans-serif;color:#1a1a2e">
    <div style="max-width:640px;margin:0 auto">

      <img src="${BANNER_URL}" alt="Shortly Daily Wrap" width="640" style="display:block;width:100%;max-width:640px;height:auto;border-radius:0 0 16px 16px">

      <div style="background:#ffffff;border-radius:18px;padding:28px 30px;margin:20px 0 20px;border:1px solid #e8e0f5;border-left:4px solid #7c3aed">
        <p style="margin:0 0 10px;color:#1a1a2e;font-size:18px;line-height:1.45;font-weight:700;font-family:Roboto,Arial,sans-serif">
          ${greeting}
        </p>
        <p style="margin:0;color:#6b6b8a;font-size:16px;line-height:1.65;font-weight:400;font-family:Roboto,Arial,sans-serif">
          Here are 10 things that deserve your attention. The biggest stories, minus the noise. Grab your coffee &mdash; you'll be caught up SHORTLY!
        </p>
        <div style="margin-top:16px;display:inline-block;padding:6px 16px;background:#8b5cf6;border-radius:999px;font-size:12px;color:#ffffff;font-weight:700;font-family:Roboto,Arial,sans-serif">
          ${readTime} min read
        </div>
      </div>

      ${renderSectionBlock("Shortly Wrapped", `${wrapped.length} stories to catch up on`, wrapped)}

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:8px;margin-bottom:32px">
        <tr><td style="text-align:center;padding:20px">
          <div style="font-size:22px;font-weight:800;color:#7c3aed;letter-spacing:-0.5px;margin-bottom:8px;font-family:Roboto,Arial,sans-serif">shortly</div>
          <p style="margin:0;color:#9a9ab0;font-size:12px;line-height:1.5;font-family:Roboto,Arial,sans-serif">
            Curated news, summarized daily.<br>
            You're receiving this because you subscribed to Shortly.
          </p>
          <p style="margin:16px 0 0;font-size:13px;line-height:1.5;font-family:Roboto,Arial,sans-serif">
            <a href="${twitterUrl}" style="color:#7c3aed;text-decoration:none;font-weight:600;font-family:Roboto,Arial,sans-serif">Share on X</a>
            &nbsp;&nbsp;|&nbsp;&nbsp;
            <a href="${linkedinUrl}" style="color:#7c3aed;text-decoration:none;font-weight:600;font-family:Roboto,Arial,sans-serif">LinkedIn</a>
            &nbsp;&nbsp;|&nbsp;&nbsp;
            <a href="${whatsappUrl}" style="color:#7c3aed;text-decoration:none;font-weight:600;font-family:Roboto,Arial,sans-serif">WhatsApp</a>
          </p>
          <p style="margin:12px 0 0;">
            <a href="${unsubUrl}" style="color:#9a9ab0;font-size:11px;text-decoration:underline;font-family:Roboto,Arial,sans-serif">Unsubscribe</a>
          </p>
        </td></tr>
      </table>

    </div>
  </div>`;
}
