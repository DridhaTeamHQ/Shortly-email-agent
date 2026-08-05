import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { sendEmail } from "../_shared/mailer.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { renderPrivacyFooter } from "../_shared/privacy.ts";
import { requireIstSendWindow } from "../_shared/send-window.ts";

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
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-agent-token, x-admin-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  // Server-side auth: service_role JWT (cron) or the dashboard's agent token.
  const denied = await requireAgent(request);
  if (denied) return denied;


  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  const sendWindowDenied = requireIstSendWindow();
  if (sendWindowDenied) return sendWindowDenied;

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
      html: await renderEmail(article, subscriber),
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

async function renderEmail(article: ArticlePayload, subscriber: Subscriber): Promise<string> {
  const name = subscriber.full_name ? ` ${escapeHtml(subscriber.full_name)}` : "";
  const source = article.source ? `<p style="color:#555555;font-weight:700;margin:0 0 12px">${escapeHtml(article.source)}</p>` : "";
  const note = article.note ? `<p style="color:#555555;margin:0 0 18px">${escapeHtml(article.note)}</p>` : "";
  const privacyFooter = await renderPrivacyFooter(subscriber.email);
  const footer = `<div style="margin:28px -30px -30px;padding:24px 20px 18px;background:#050505;color:#ffffff;text-align:center;font:13px/1.5 Roboto,Arial,sans-serif"><strong style="font:700 22px/1 'Roboto Serif',Georgia,serif">DailyMattr<sup style="font-size:9px">®</sup></strong><br>Curated news, summarized daily.<br><a href="https://longmattr.com/" style="display:inline-block;margin-top:12px;background:#202020;color:#ffffff;border-radius:22px;padding:10px 18px;text-decoration:none;font-weight:700">Subscribe</a></div>`;

  return `
    <div style="margin:0;background:#ffffff;padding:32px;font-family:Roboto,Arial,sans-serif;color:#191919">
      <div style="max-width:640px;margin:0 auto">
        <img src="${BANNER_URL}" alt="Shortly Daily Wrap" width="640" style="display:block;width:100%;max-width:640px;height:auto;border-radius:0 0 16px 16px">
      </div>
      <div style="max-width:620px;margin:20px auto 0;background:#ffffff;border-radius:12px;padding:30px;border:1px solid #111111">
        <p style="margin:0 0 18px;color:#191919;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">Hi${name},</p>
        ${note}
        ${source}
        <h1 style="font-size:32px;line-height:1.12;margin:0 0 16px;color:#191919;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${escapeHtml(article.title)}</h1>
        <p style="font-size:16px;line-height:1.7;color:#3f3f46;margin:0 0 24px">${escapeHtml(article.summary)}</p>
        <a href="${escapeHtml(article.url)}" style="display:inline-block;background:#202020;color:#ffffff;text-decoration:none;font-weight:700;border-radius:10px;padding:13px 18px">Read article</a>
        ${footer}
        ${privacyFooter}
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
