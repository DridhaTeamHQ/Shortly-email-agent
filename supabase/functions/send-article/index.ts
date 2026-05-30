import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { sendEmail } from "../_shared/mailer.ts";

type ArticlePayload = {
  title: string;
  url: string;
  summary: string;
  source?: string;
  topic?: string;
  note?: string;
};

type Subscriber = {
  id: string;
  email: string;
  full_name: string | null;
};

const BANNER_URL =
  Deno.env.get("SHORTLY_BANNER_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/email-banner.jpg";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const article = await request.json() as ArticlePayload;
  const validationError = validateArticle(article);
  if (validationError) {
    return json({ error: validationError }, 400);
  }

  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data: subscribers, error: subscriberError } = await supabase
    .from("subscribers")
    .select("id,email,full_name")
    .eq("status", "subscribed");

  if (subscriberError) {
    return json({ error: subscriberError.message }, 500);
  }

  const { data: storedArticle, error: articleError } = await supabase
    .from("articles")
    .insert(article)
    .select("id")
    .single();

  if (articleError) {
    return json({ error: articleError.message }, 500);
  }

  let sent = 0;
  let failed = 0;

  for (const subscriber of subscribers as Subscriber[]) {
    const result = await sendEmail({
      to: subscriber.email,
      subject: article.title,
      html: renderEmail(article, subscriber),
    });

    if (result.ok) {
      sent += 1;
    } else {
      failed += 1;
    }

    await supabase.from("article_deliveries").insert({
      article_id: storedArticle.id,
      subscriber_id: subscriber.id,
      email: subscriber.email,
      status: result.ok ? "sent" : "failed",
      provider_message_id: result.messageId,
      error: result.error
    });
  }

  return json({ articleId: storedArticle.id, recipients: subscribers?.length ?? 0, sent, failed });
});

function validateArticle(article: ArticlePayload) {
  if (!article?.title?.trim()) return "title is required";
  if (!article?.url?.trim()) return "url is required";
  if (!article?.summary?.trim()) return "summary is required";

  try {
    new URL(article.url);
  } catch {
    return "url must be valid";
  }

  return "";
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function renderEmail(article: ArticlePayload, subscriber: Subscriber) {
  const name = subscriber.full_name ? ` ${escapeHtml(subscriber.full_name)}` : "";
  const source = article.source ? `<p style="color:#6d28d9;font-weight:700;margin:0 0 12px">${escapeHtml(article.source)}</p>` : "";
  const note = article.note ? `<p style="color:#5f5673;margin:0 0 18px">${escapeHtml(article.note)}</p>` : "";

  return `
    <div style="margin:0;background:#f5f3ff;padding:32px;font-family:Roboto,Arial,sans-serif;color:#2d0f57">
      <div style="max-width:640px;margin:0 auto">
        <img src="${BANNER_URL}" alt="Shortly Daily Wrap" width="640" style="display:block;width:100%;max-width:640px;height:auto;border-radius:0 0 16px 16px">
      </div>
      <div style="max-width:620px;margin:20px auto 0;background:linear-gradient(180deg,#ffffff 0%,#fbf8ff 100%);border-radius:22px;padding:30px;border:1px solid #e8e0f5;border-left:5px solid #7c3aed;box-shadow:0 10px 28px rgba(109,40,217,0.06)">
        <p style="margin:0 0 18px;color:#6d28d9;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">Hi${name},</p>
        ${note}
        ${source}
        <h1 style="font-size:32px;line-height:1.12;margin:0 0 16px;color:#51209a;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${escapeHtml(article.title)}</h1>
        <p style="font-size:16px;line-height:1.7;color:#5f5673;margin:0 0 24px">${escapeHtml(article.summary)}</p>
        <a href="${escapeHtml(article.url)}" style="display:inline-block;background:#6d28d9;color:#ffffff;text-decoration:none;font-weight:700;border-radius:10px;padding:13px 18px">Read article</a>
      </div>
    </div>
  `;
}

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
