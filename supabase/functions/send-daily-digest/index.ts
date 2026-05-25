// send-daily-digest: Two-section newsletter with fallback auto-select.
// Section 1: "Shortly Wrapped" — 5 stories to catch up on
// Section 2: "Shortly Ahead"   — 5 stories to look out for
// Guarantees at least 1 finance/business article per section.
// Fallback: if QA hasn't approved enough, auto-selects from summarized pool.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { sendEmail } from "../_shared/mailer.ts";
import { generateUnsubToken } from "../_shared/unsub.ts";

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
  prominence: number;
};

type Subscriber = { id: string; email: string; full_name: string | null };

const SECTION_SIZE = 5;
const TOTAL_ARTICLES = SECTION_SIZE * 2;
const FINANCE_TOPICS = ["business", "india business", "finance", "economy", "markets"];

// Hosted brand assets (public Supabase Storage bucket)
const BANNER_URL = "https://ygxdrphajvrbjcaxhvcn.supabase.co/storage/v1/object/public/assets/banner.jpeg";
const FOOTER_LOGO_URL = "https://ygxdrphajvrbjcaxhvcn.supabase.co/storage/v1/object/public/assets/shortlyfooter.png";

// Sans-serif stack — applied to every text element so clients never fall back to Times.
const FONT = "Inter,'Helvetica Neue',Helvetica,Arial,sans-serif";

function isFinance(a: Article): boolean {
  return FINANCE_TOPICS.includes((a.topic ?? "").toLowerCase());
}

const FINANCE_PER_SECTION = 2;

/** Split articles into wrapped (5) and ahead (5), guaranteeing 2 finance each. */
function splitSections(articles: Article[]): { wrapped: Article[]; ahead: Article[] } {
  const wrapped: Article[] = [];
  const ahead: Article[] = [];

  // First pass: place articles by their GPT-assigned section
  for (const a of articles) {
    if (a.section === "ahead" && ahead.length < SECTION_SIZE) ahead.push(a);
    else if (wrapped.length < SECTION_SIZE) wrapped.push(a);
    else if (ahead.length < SECTION_SIZE) ahead.push(a);
  }

  // Guarantee 2 finance per section
  ensureFinance(wrapped, ahead, articles);
  ensureFinance(ahead, wrapped, articles);

  return { wrapped, ahead };
}

/** Ensure `target` has at least FINANCE_PER_SECTION finance articles. */
function ensureFinance(target: Article[], other: Article[], pool: Article[]) {
  const finCount = target.filter(isFinance).length;
  let needed = FINANCE_PER_SECTION - finCount;
  if (needed <= 0) return;

  const usedIds = () => new Set([...target, ...other].map((a) => a.id));

  // First, try swapping non-finance from target with finance from pool
  const allFinance = pool.filter((a) => isFinance(a) && !usedIds().has(a.id));
  for (const fin of allFinance) {
    if (needed <= 0) break;
    // Find a non-finance article in target to replace
    const nonFinIdx = target.findIndex((a) => !isFinance(a));
    if (nonFinIdx !== -1) {
      const replaced = target.splice(nonFinIdx, 1)[0];
      target.push(fin);
      if (other.length < SECTION_SIZE) other.push(replaced);
      needed--;
    }
  }

  // If still short, try taking finance from the other section
  while (needed > 0) {
    const otherFinIdx = other.findIndex(isFinance);
    if (otherFinIdx === -1) break;
    const fin = other.splice(otherFinIdx, 1)[0];
    const nonFinIdx = target.findIndex((a) => !isFinance(a));
    if (nonFinIdx !== -1) {
      const replaced = target.splice(nonFinIdx, 1)[0];
      target.push(fin);
      other.push(replaced);
    } else {
      target.push(fin);
    }
    needed--;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  // 1. Try approved articles first
  const { data: approved, error: approvedError } = await supabase
    .from("articles")
    .select("id,title,edited_title,url,summary,edited_summary,source,topic,section,rank_score,prominence")
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
      .select("id,title,edited_title,url,summary,edited_summary,source,topic,section,rank_score,prominence")
      .eq("status", "summarized")
      .order("rank_score", { ascending: false })
      .order("scraped_at", { ascending: false })
      .limit(need + 10); // grab extra for finance guarantee

    const extras = ((fallback ?? []) as Article[]).filter((a) => !usedIds.includes(a.id));
    articles = [...articles, ...extras].slice(0, 20);
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

  // Cap at 10 and split into sections
  articles = articles.slice(0, TOTAL_ARTICLES);
  const { wrapped, ahead } = splitSections(articles);
  const allArticles = [...wrapped, ...ahead];

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
    const html = await renderDigest(wrapped, ahead, sub);
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
    ahead: ahead.length,
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
      const headline = (a.edited_title || a.title || "").trim();
      const meta = escapeHtml((a.topic ?? "Top story").toUpperCase());
      const breaking = (a.prominence ?? 0) >= 4;
      const topicChip = `<span style="display:inline-block;font-family:${FONT};background:#f3eefc;color:#7c3aed;font-size:10px;font-weight:700;letter-spacing:0.08em;padding:4px 11px;border-radius:999px">${meta}</span>`;
      const breakingChip = breaking
        ? `<span style="display:inline-block;font-family:${FONT};background:#dc2626;color:#fff;font-size:9px;font-weight:800;padding:4px 9px;border-radius:999px;letter-spacing:0.06em;margin-left:6px">BREAKING</span>`
        : "";
      return `
        <tr><td style="padding:22px 0;${i < articles.length - 1 ? "border-bottom:1px solid #f0ecf8;" : ""}">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
            <td style="width:46px;vertical-align:top;padding-top:3px">
              <div style="width:36px;height:36px;border-radius:11px;font-family:${FONT};background:#7c3aed;background:linear-gradient(135deg,#7c3aed 0%,#a855f7 100%);color:#ffffff;font-size:16px;font-weight:800;text-align:center;line-height:36px;box-shadow:0 4px 10px rgba(124,58,237,0.28)">
                ${i + 1}
              </div>
            </td>
            <td style="padding-left:14px">
              <div style="margin-bottom:8px">${topicChip}${breakingChip}</div>
              <h2 style="font-family:${FONT};font-size:18px;line-height:1.35;margin:0 0 9px;color:#1a1a2e;font-weight:700;letter-spacing:-0.2px">
                ${escapeHtml(headline)}
              </h2>
              <p style="font-family:${FONT};font-size:15px;line-height:1.7;color:#54546e;margin:0">${escapeHtml(text)}</p>
            </td>
          </tr></table>
        </td></tr>`;
    })
    .join("");
}

function renderSectionBlock(title: string, subtitle: string, articles: Article[]): string {
  if (articles.length === 0) return "";
  return `
      <div style="background:#ffffff;border-radius:18px;border:1px solid #ece6f7;margin-bottom:18px;overflow:hidden;box-shadow:0 6px 24px rgba(124,58,237,0.06)">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
          <tr><td style="background:#7c3aed;background:linear-gradient(120deg,#7c3aed 0%,#9d5cf5 100%);padding:22px 28px">
            <div style="font-family:${FONT};font-size:21px;font-weight:800;color:#ffffff;letter-spacing:-0.3px">${escapeHtml(title)}</div>
            <div style="font-family:${FONT};margin-top:4px;font-size:13px;color:#e8dcfc;font-weight:500">${escapeHtml(subtitle)}</div>
          </td></tr>
          <tr><td style="padding:6px 28px 14px">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              ${renderItems(articles)}
            </table>
          </td></tr>
        </table>
      </div>`;
}

async function renderDigest(wrapped: Article[], ahead: Article[], sub: Subscriber): Promise<string> {
  const greeting = sub.full_name ? `Hi ${escapeHtml(sub.full_name)},` : "Hi there,";
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // Read time estimate
  const allArticles = [...wrapped, ...ahead];
  const totalWords = allArticles.reduce((sum, a) => {
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
  <div style="margin:0;background:#f5f3ff;padding:0;font-family:'Inter','Helvetica Neue',Arial,sans-serif;color:#1a1a2e">
    <div style="max-width:640px;margin:0 auto">

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
        <tr><td style="padding:0;font-size:0;line-height:0">
          <img src="${BANNER_URL}" alt="Shortly Daily Wrap — 10 Stories. 10 min." width="640" style="display:block;width:100%;max-width:640px;height:auto;border:0;border-radius:0 0 16px 16px" />
        </td></tr>
      </table>

      <div style="background:#ffffff;border-radius:18px;padding:28px;margin:20px 0 18px;border:1px solid #ece6f7;border-left:4px solid #7c3aed">
        <p style="font-family:${FONT};margin:0 0 6px;color:#1a1a2e;font-size:17px;font-weight:700">${greeting}</p>
        <p style="font-family:${FONT};margin:0 0 14px;color:#6b6b8a;font-size:14px;line-height:1.65">
          We read everything &mdash; so you get only what matters.<br>
          Here's your quick news update for ${escapeHtml(today)}.
        </p>
        <span style="display:inline-block;font-family:${FONT};padding:6px 14px;background:#7c3aed;background:linear-gradient(120deg,#7c3aed,#a855f7);border-radius:999px;font-size:12px;color:#ffffff;font-weight:700;letter-spacing:0.02em">${readTime} min read</span>
      </div>

      ${renderSectionBlock("Shortly Wrapped", `${wrapped.length} stories to catch up on`, wrapped)}
      ${renderSectionBlock("Shortly Ahead", `${ahead.length} stories to look out for`, ahead)}

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:8px;margin-bottom:32px">
        <tr><td style="text-align:center;padding:28px 20px">
          <img src="${FOOTER_LOGO_URL}" alt="Shortly" width="130" style="display:block;width:130px;max-width:60%;height:auto;border:0;margin:0 auto 12px" />
          <p style="font-family:${FONT};margin:0 0 18px;color:#9a9ab0;font-size:12px;line-height:1.5">
            Curated news, summarized daily.<br>
            You're receiving this because you subscribed to Shortly.
          </p>
          <p style="margin:0 0 18px;font-size:13px;line-height:1.5">
            <a href="${twitterUrl}" style="display:inline-block;font-family:${FONT};background:#f3eefc;color:#7c3aed;text-decoration:none;font-weight:600;font-size:12px;padding:9px 18px;border-radius:999px;margin:0 4px 6px">Share on X</a>
            <a href="${linkedinUrl}" style="display:inline-block;font-family:${FONT};background:#f3eefc;color:#7c3aed;text-decoration:none;font-weight:600;font-size:12px;padding:9px 18px;border-radius:999px;margin:0 4px 6px">LinkedIn</a>
            <a href="${whatsappUrl}" style="display:inline-block;font-family:${FONT};background:#f3eefc;color:#7c3aed;text-decoration:none;font-weight:600;font-size:12px;padding:9px 18px;border-radius:999px;margin:0 4px 6px">WhatsApp</a>
          </p>
          <p style="margin:0;">
            <a href="${unsubUrl}" style="font-family:${FONT};color:#b0b0c0;font-size:11px;text-decoration:underline">Unsubscribe</a>
          </p>
        </td></tr>
      </table>

    </div>
  </div>`;
}
