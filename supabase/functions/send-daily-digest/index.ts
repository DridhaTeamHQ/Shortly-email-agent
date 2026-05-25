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
      const meta = escapeHtml(a.topic ?? "Top story");
      const prominenceBadge = (a.prominence ?? 0) >= 4
        ? `<span style="display:inline-block;background:#dc2626;color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;margin-left:8px;vertical-align:middle;letter-spacing:0.05em">BREAKING</span>`
        : "";
      return `
        <tr><td style="padding:24px 0;${i < articles.length - 1 ? "border-bottom:1px solid #ede7f6;" : ""}">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
            <td style="width:40px;vertical-align:top;padding-top:2px">
              <div style="width:32px;height:32px;border-radius:50%;background:#7c3aed;color:#ffffff;font-size:14px;font-weight:700;text-align:center;line-height:32px">
                ${i + 1}
              </div>
            </td>
            <td style="padding-left:14px">
              <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#7c3aed;font-weight:600;margin-bottom:6px">
                ${meta}
              </div>
              <h2 style="font-size:18px;line-height:1.35;margin:0 0 10px;color:#1a1a2e;font-weight:700">
                ${escapeHtml(headline)}${prominenceBadge}
              </h2>
              <p style="font-size:15px;line-height:1.7;color:#4a4a68;margin:0">${escapeHtml(text)}</p>
            </td>
          </tr></table>
        </td></tr>`;
    })
    .join("");
}

function renderSectionBlock(title: string, subtitle: string, articles: Article[]): string {
  if (articles.length === 0) return "";
  return `
      <div style="background:#ffffff;border-radius:16px;padding:8px 28px;border:1px solid #e8e0f5;margin-bottom:16px">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
          <tr><td style="padding:24px 0 4px">
            <h2 style="margin:0 0 4px;font-size:20px;font-weight:800;color:#1a1a2e;letter-spacing:-0.3px">${escapeHtml(title)}</h2>
            <p style="margin:0;font-size:13px;color:#9a9ab0;font-weight:500">${escapeHtml(subtitle)}</p>
          </td></tr>
          <tr><td><div style="border-top:2px solid #7c3aed;margin:12px 0 0"></div></td></tr>
          ${renderItems(articles)}
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

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#7c3aed;border-radius:0 0 16px 16px">
        <tr><td style="padding:36px 32px 28px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-0.5px">shortly</div>
          <p style="margin:8px 0 0;color:#e0d4fc;font-size:13px;font-weight:500">${escapeHtml(today)}</p>
        </td></tr>
      </table>

      <div style="background:#ffffff;border-radius:16px;padding:32px 28px;margin:20px 0 16px;border:1px solid #e8e0f5">
        <p style="margin:0 0 4px;color:#1a1a2e;font-size:16px;font-weight:600">${greeting}</p>
        <p style="margin:0;color:#6b6b8a;font-size:14px;line-height:1.6">
          We read everything &mdash; so you get only what matters.<br>
          Here's your quick news update for the day.
          <span style="display:inline-block;margin-left:8px;padding:2px 10px;background:#f0ecfa;border-radius:12px;font-size:12px;color:#7c3aed;font-weight:600">${readTime} min read</span>
        </p>
      </div>

      ${renderSectionBlock("Shortly Wrapped", `${wrapped.length} stories to catch up on`, wrapped)}
      ${renderSectionBlock("Shortly Ahead", `${ahead.length} stories to look out for`, ahead)}

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:8px;margin-bottom:32px">
        <tr><td style="text-align:center;padding:20px">
          <div style="font-size:22px;font-weight:800;color:#7c3aed;letter-spacing:-0.5px;margin-bottom:8px">shortly</div>
          <p style="margin:0;color:#9a9ab0;font-size:12px;line-height:1.5">
            Curated news, summarized daily.<br>
            You're receiving this because you subscribed to Shortly.
          </p>
          <p style="margin:16px 0 0;font-size:13px;line-height:1.5">
            <a href="${twitterUrl}" style="color:#7c3aed;text-decoration:none;font-weight:600">Share on X</a>
            &nbsp;&nbsp;|&nbsp;&nbsp;
            <a href="${linkedinUrl}" style="color:#7c3aed;text-decoration:none;font-weight:600">LinkedIn</a>
            &nbsp;&nbsp;|&nbsp;&nbsp;
            <a href="${whatsappUrl}" style="color:#7c3aed;text-decoration:none;font-weight:600">WhatsApp</a>
          </p>
          <p style="margin:12px 0 0;">
            <a href="${unsubUrl}" style="color:#9a9ab0;font-size:11px;text-decoration:underline">Unsubscribe</a>
          </p>
        </td></tr>
      </table>

    </div>
  </div>`;
}
