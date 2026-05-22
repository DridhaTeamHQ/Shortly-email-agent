// send-daily-digest: take up to 10 highest-ranked APPROVED articles,
// render one professional digest email, send to every subscribed user via Resend,
// log per-recipient deliveries, and mark articles as `sent`.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { sendEmail } from "../_shared/mailer.ts";

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
      to: sub.email,
      subject,
      html: renderDigest(articles, sub),
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
      const meta = escapeHtml(a.topic ?? "Top story");
      return `
        <tr><td style="padding:28px 0;border-bottom:1px solid #ede7f6">
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
                ${escapeHtml(a.title)}
              </h2>
              <p style="font-size:15px;line-height:1.7;color:#4a4a68;margin:0">${escapeHtml(text)}</p>
            </td>
          </tr></table>
        </td></tr>
      `;
    })
    .join("");

  return `
  <div style="margin:0;background:#f5f3ff;padding:0;font-family:'Inter','Helvetica Neue',Arial,sans-serif;color:#1a1a2e">
    <div style="max-width:640px;margin:0 auto">

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#7c3aed;border-radius:0 0 16px 16px">
        <tr><td style="padding:36px 32px 28px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-0.5px">shortly</div>
          <p style="margin:8px 0 0;color:#e0d4fc;font-size:13px;font-weight:500">${escapeHtml(today)}</p>
        </td></tr>
      </table>

      <div style="background:#ffffff;border-radius:16px;padding:32px 28px;margin:20px 0;border:1px solid #e8e0f5">
        <p style="margin:0 0 4px;color:#1a1a2e;font-size:16px;font-weight:600">${greeting}</p>
        <p style="margin:0 0 0;color:#6b6b8a;font-size:14px;line-height:1.6">
          Here's your ${articles.length}-story briefing for today.
        </p>
      </div>

      <div style="background:#ffffff;border-radius:16px;padding:8px 28px;border:1px solid #e8e0f5">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
          ${items}
        </table>
      </div>

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:24px;margin-bottom:32px">
        <tr><td style="text-align:center;padding:20px">
          <div style="font-size:22px;font-weight:800;color:#7c3aed;letter-spacing:-0.5px;margin-bottom:8px">shortly</div>
          <p style="margin:0;color:#9a9ab0;font-size:12px;line-height:1.5">
            Curated news, summarized daily.<br>
            You're receiving this because you subscribed to Shortly.
          </p>
        </td></tr>
      </table>

    </div>
  </div>`;
}
