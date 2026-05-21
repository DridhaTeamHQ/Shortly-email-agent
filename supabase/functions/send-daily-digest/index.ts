// send-daily-digest: take up to 10 highest-ranked APPROVED articles,
// render one professional digest email, send to every subscribed user via Resend,
// log per-recipient deliveries, and mark articles as `sent`.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";

type Article = {
  id: string;
  title: string;
  url: string;
  summary: string | null;
  edited_summary: string | null;
  source: string | null;
  topic: string | null;
};

type Subscriber = { id: string; email: string; full_name: string | null };

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const resendApiKey = requiredEnv("RESEND_API_KEY");
  const fromEmail = Deno.env.get("FROM_EMAIL") ?? "Shortly Digest <digest@example.com>";

  // Pick top 10 approved by rank
  const { data: approved, error: approvedError } = await supabase
    .from("articles")
    .select("id,title,url,summary,edited_summary,source,topic,rank_score")
    .eq("status", "approved")
    .order("rank_score", { ascending: false })
    .order("scraped_at", { ascending: false })
    .limit(10);

  if (approvedError) return json({ error: approvedError.message }, 500);
  const articles = (approved ?? []) as Article[];
  if (articles.length === 0) return json({ error: "No approved articles to send" }, 400);

  // Subscribers
  const { data: subs, error: subError } = await supabase
    .from("subscribers")
    .select("id,email,full_name")
    .eq("status", "subscribed");
  if (subError) return json({ error: subError.message }, 500);
  const subscribers = (subs ?? []) as Subscriber[];

  // Create digest log row
  const { data: digest, error: digestError } = await supabase
    .from("digests")
    .insert({ article_ids: articles.map((a) => a.id), recipients: subscribers.length })
    .select("id")
    .single();
  if (digestError) return json({ error: digestError.message }, 500);
  const digestId = digest!.id as string;

  const subject = `${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} — Shortly Digest`;

  let sent = 0;
  let failed = 0;

  for (const sub of subscribers) {
    const result = await sendEmail({
      apiKey: resendApiKey,
      from: fromEmail,
      to: sub.email,
      subject,
      html: renderDigest(articles, sub)
    });
    if (result.ok) sent++;
    else failed++;
    await supabase.from("article_deliveries").insert({
      digest_id: digestId,
      subscriber_id: sub.id,
      email: sub.email,
      status: result.ok ? "sent" : "failed",
      provider_message_id: result.messageId ?? null,
      error: result.error ?? null
    });
  }

  // Mark articles as sent
  await supabase
    .from("articles")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .in("id", articles.map((a) => a.id));

  await supabase.from("digests").update({ sent, failed }).eq("id", digestId);

  return json({ digestId, articles: articles.length, recipients: subscribers.length, sent, failed });
});

async function sendEmail(opts: { apiKey: string; from: string; to: string; subject: string; html: string }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: opts.from, to: opts.to, subject: opts.subject, html: opts.html })
  });
  const body = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    messageId: body.id as string | undefined,
    error: response.ok ? null : (body.message ?? `Resend ${response.status}`)
  };
}

function escapeHtml(v = "") {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderDigest(articles: Article[], sub: Subscriber): string {
  const greeting = sub.full_name ? `Hi ${escapeHtml(sub.full_name)},` : "Hi there,";
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  });

  const items = articles
    .map((a, i) => {
      const text = (a.edited_summary || a.summary || "").trim();
      const meta = [a.source, a.topic].filter(Boolean).map((s) => escapeHtml(s!)).join(" · ");
      return `
        <tr><td style="padding:24px 0;border-bottom:1px solid #e6ecf2">
          <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#2acfcf;font-weight:700;margin-bottom:6px">
            ${String(i + 1).padStart(2, "0")} · ${meta || "Top story"}
          </div>
          <h2 style="font-size:20px;line-height:1.3;margin:0 0 10px;color:#242a45">
            <a href="${escapeHtml(a.url)}" style="color:#242a45;text-decoration:none">${escapeHtml(a.title)}</a>
          </h2>
          <p style="font-size:15px;line-height:1.65;color:#4b5066;margin:0 0 12px">${escapeHtml(text)}</p>
          <a href="${escapeHtml(a.url)}" style="font-size:14px;color:#1fa4ad;font-weight:600;text-decoration:none">Read full story →</a>
        </td></tr>
      `;
    })
    .join("");

  return `
  <div style="margin:0;background:#f3f7fb;padding:32px 16px;font-family:Inter,Arial,sans-serif;color:#242a45">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #dce7ef">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
        <strong style="font-size:18px;color:#242a45">Shortly Digest</strong>
        <span style="font-size:13px;color:#6a7188">${escapeHtml(today)}</span>
      </div>
      <p style="margin:0 0 8px;color:#4b5066">${greeting}</p>
      <p style="margin:0 0 4px;color:#6a7188;font-size:14px;line-height:1.6">
        Your ${articles.length}-story briefing of today's most important news, curated and summarized.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:8px">
        ${items}
      </table>
      <p style="margin:28px 0 0;color:#9aa1b4;font-size:12px;text-align:center">
        You're receiving this because you subscribed to Shortly Digest.
      </p>
    </div>
  </div>`;
}
