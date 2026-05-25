import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { sendEmail } from "../_shared/mailer.ts";
import { generateUnsubToken } from "../_shared/unsub.ts";

const BANNER_DATA_URL = loadBannerDataUrl();

function loadBannerDataUrl(): string {
  const bytes = Deno.readFileSync(new URL("../../../assets/email-banner.jpg", import.meta.url));
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  if (request.method === "GET") {
    const { data, error } = await supabase
      .from("subscribers")
      .select("id,email,full_name,status,created_at")
      .order("created_at", { ascending: false });
    if (error) return json({ error: error.message }, 500);
    return json({ subscribers: data });
  }

  if (request.method === "POST") {
    const body = await request.json();
    const { action } = body;

    if (action === "add") {
      const { email, full_name } = body;
      if (!email?.trim()) return json({ error: "email is required" }, 400);
      const { error } = await supabase
        .from("subscribers")
        .insert({ email: email.trim(), full_name: full_name?.trim() || null });
      if (error) return json({ error: error.message }, 400);

      // Send the latest digest as a welcome email (fire-and-forget)
      sendWelcomeDigest(supabase, email.trim(), full_name?.trim() || null).catch(() => {});

      return json({ ok: true });
    }

    if (action === "update") {
      const { id, status } = body;
      if (!id) return json({ error: "id is required" }, 400);
      const { error } = await supabase
        .from("subscribers")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "delete") {
      const { id } = body;
      if (!id) return json({ error: "id is required" }, 400);
      const { error } = await supabase
        .from("subscribers")
        .delete()
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  }

  return json({ error: "Method not allowed" }, 405);
});

function escapeHtml(v = "") {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function sendWelcomeDigest(
  supabase: ReturnType<typeof createClient>,
  email: string,
  fullName: string | null,
) {
  const { data: articles } = await supabase
    .from("articles")
    .select("title,url,summary,edited_summary,source,topic,section")
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(10);

  if (!articles || articles.length === 0) return;

  const greeting = fullName ? `Hey ${escapeHtml(fullName)},` : "Hey there,";
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  type WelcomeArticle = Record<string, string | null>;

  function renderItems(list: WelcomeArticle[]): string {
    return list.map((a, i) => {
      const text = (a.edited_summary || a.summary || "").trim();
      const meta = escapeHtml((a.topic as string) ?? "Top story");
      return `<tr><td style="padding:24px 0;${i < list.length - 1 ? "border-bottom:1px solid #ede7f6;" : ""}">
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
              ${escapeHtml(a.title!)}
            </h2>
            <p style="font-size:15px;line-height:1.7;color:#4a4a68;margin:0">${escapeHtml(text)}</p>
          </td>
        </tr></table>
      </td></tr>`;
    }).join("");
  }

  function renderSection(title: string, subtitle: string, list: WelcomeArticle[]): string {
    if (list.length === 0) return "";
    return `
      <div style="background:#ffffff;border-radius:16px;padding:8px 28px;border:1px solid #e8e0f5;margin-bottom:16px">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
          <tr><td style="padding:24px 0 4px">
          <h2 style="margin:0 0 4px;font-size:20px;font-weight:800;color:#1a1a2e;letter-spacing:-0.3px;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${escapeHtml(title)}</h2>
            <p style="margin:0;font-size:13px;color:#9a9ab0;font-weight:500">${escapeHtml(subtitle)}</p>
          </td></tr>
          <tr><td><div style="border-top:2px solid #7c3aed;margin:12px 0 0"></div></td></tr>
          ${renderItems(list)}
        </table>
      </div>`;
  }

  // Split into sections
  const wrapped = articles.filter((a: WelcomeArticle) => a.section !== "ahead").slice(0, 5);
  const ahead = articles.filter((a: WelcomeArticle) => a.section === "ahead").slice(0, 5);
  // If not enough in one section, fill from the other
  if (wrapped.length < 5) {
    const extra = articles.filter((a: WelcomeArticle) => !wrapped.includes(a) && !ahead.includes(a));
    wrapped.push(...extra.slice(0, 5 - wrapped.length));
  }
  if (ahead.length < 5) {
    const extra = articles.filter((a: WelcomeArticle) => !wrapped.includes(a) && !ahead.includes(a));
    ahead.push(...extra.slice(0, 5 - ahead.length));
  }

  // Read time estimate
  const allItems = [...wrapped, ...ahead];
  const totalWords = allItems.reduce((sum, a) => {
    const text = ((a.edited_summary || a.summary || "") as string).trim();
    return sum + text.split(/\s+/).filter(Boolean).length;
  }, 0);
  const readTime = Math.max(1, Math.ceil(totalWords / 200));

  // Unsubscribe link
  const secret = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const unsubToken = await generateUnsubToken(email, secret);
  const unsubUrl = `https://ygxdrphajvrbjcaxhvcn.functions.supabase.co/unsubscribe?email=${encodeURIComponent(email)}&token=${encodeURIComponent(unsubToken)}`;

  // Social sharing
  const shareText = encodeURIComponent("Check out Shortly newsletter — curated news, summarized daily.");
  const twitterUrl = `https://twitter.com/intent/tweet?text=${shareText}`;
  const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent("https://shortly.news")}&summary=${shareText}`;
  const whatsappUrl = `https://wa.me/?text=${shareText}`;

  const html = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;800&family=Roboto+Serif:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <div style="margin:0;background:#f5f3ff;padding:0;font-family:Roboto,Arial,sans-serif;color:#1a1a2e">
    <div style="max-width:640px;margin:0 auto">

      <img src="${BANNER_DATA_URL}" alt="Shortly Daily Wrap" width="640" style="display:block;width:100%;max-width:640px;height:auto;border-radius:0 0 16px 16px">

      <div style="background:#ffffff;border-radius:16px;padding:32px 28px;margin:20px 0 16px;border:1px solid #e8e0f5">
        <p style="margin:0 0 12px;color:#1a1a2e;font-size:18px;line-height:1.45;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${greeting}</p>
        <p style="margin:0;color:#6b6b8a;font-size:18px;line-height:1.6;font-weight:400;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">
          Here are 10 things that deserve your attention. The biggest stories, minus the noise. Grab your coffee &mdash; you'll be caught up SHORTLY!
        </p>
        <div style="margin-top:18px;display:inline-block;padding:6px 16px;background:#f0ecfa;border:1px solid #e8e0f5;border-radius:999px;font-size:12px;color:#7c3aed;font-weight:600;font-family:Roboto,Arial,sans-serif">${readTime} min read</div>
      </div>

      ${renderSection("Shortly Wrapped", `${wrapped.length} stories to catch up on`, wrapped)}

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

  await sendEmail({
    to: email,
    subject: `Welcome to Shortly Digest — ${today}`,
    html,
  });
}
