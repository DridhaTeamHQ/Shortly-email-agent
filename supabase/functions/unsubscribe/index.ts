// unsubscribe: Handle email unsubscribe via GET (browser link) or POST (programmatic).
// GET  ?email=xxx&token=xxx  → HTML confirmation page
// POST { email, token }      → JSON response

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { verifyUnsubToken } from "../_shared/unsub.ts";

function escapeHtml(v = "") {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** Dailymattr-branded HTML confirmation page (purple theme). */
function htmlPage(title: string, message: string, success: boolean): Response {
  const accentColor = success ? "#3979ff" : "#dc2626";
  const icon = success
    ? `<div style="width:64px;height:64px;border-radius:50%;background:#eaf1ff;margin:0 auto 20px;display:flex;align-items:center;justify-content:center">
         <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3979ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
           <polyline points="20 6 9 17 4 12"/>
         </svg>
       </div>`
    : `<div style="width:64px;height:64px;border-radius:50%;background:#fee2e2;margin:0 auto 20px;display:flex;align-items:center;justify-content:center">
         <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
           <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
         </svg>
       </div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escapeHtml(title)} - Dailymattr</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Inter','Helvetica Neue',Arial,sans-serif;background:#f4f8ff;color:#1a1a2e;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
    .header{font-size:28px;font-weight:800;color:#3979ff;letter-spacing:-0.5px;margin-bottom:40px}
    .card{background:#ffffff;border-radius:16px;padding:48px 40px;max-width:480px;width:100%;text-align:center;border:1px solid #d7e5ff;box-shadow:0 4px 24px rgba(57,121,255,0.12)}
    .card h1{font-size:22px;font-weight:700;color:${accentColor};margin-bottom:12px;letter-spacing:-0.3px}
    .card p{font-size:15px;line-height:1.6;color:#6b6b8a}
    .footer{margin-top:40px;text-align:center;color:#9a9ab0;font-size:12px;line-height:1.5}
  </style>
</head>
<body>
  <div class="header">Dailymattr</div>
  <div class="card">
    ${icon}
    <h1>${escapeHtml(title)}</h1>
    <p>${message}</p>
  </div>
  <div class="footer">
    Curated news, summarized daily.<br>
    &copy; ${new Date().getFullYear()} Dailymattr
  </div>
</body>
</html>`;

  return new Response(html, {
    status: success ? 200 : 400,
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Core unsubscribe logic shared by GET and POST handlers. */
async function processUnsubscribe(
  email: string | null,
  token: string | null,
  action = "unsubscribe",
): Promise<{ ok: boolean; error?: string }> {
  if (!email?.trim() || !token?.trim()) {
    return { ok: false, error: "Missing email or token parameter." };
  }

  const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const valid = await verifyUnsubToken(email, token, serviceKey);
  if (!valid) {
    return { ok: false, error: "Invalid or expired unsubscribe link." };
  }

  const supabase = createClient(
    requiredEnv("SUPABASE_URL"),
    serviceKey,
  );
  const normalizedEmail = email.trim().toLowerCase();

  const { data: profiles, error: profileError } = await supabase
    .from("profiles")
    .select("id")
    .eq("email", normalizedEmail);
  if (profileError) {
    return { ok: false, error: "Database error. Please try again later." };
  }
  const accountIds = (profiles ?? []).map((profile) => profile.id as string);

  // Check subscriber exists
  const { data: subscriber, error: fetchError } = await supabase
    .from("subscribers")
    .select("id,status")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (fetchError) {
    return { ok: false, error: "Database error. Please try again later." };
  }

  if (!subscriber && accountIds.length === 0) {
    return { ok: false, error: "Email address not found in our subscriber list." };
  }

  if (action !== "delete" && subscriber?.status === "unsubscribed" && accountIds.length === 0) {
    // Already unsubscribed — treat as success
    return { ok: true };
  }

  if (action === "delete") {
    if (accountIds.length > 0) {
      const { error: accountDeleteError } = await supabase
        .from("newsletter_subscriptions")
        .delete()
        .in("user_id", accountIds);
      if (accountDeleteError) {
        return { ok: false, error: "Failed to delete your data. Please try again later." };
      }
    }
    // Remove delivery rows first so the subscriber's personal data is not
    // retained through a recipient-linked record.
    await supabase.from("article_deliveries").delete().eq("email", normalizedEmail);
    const { error: deleteError } = await supabase
      .from("subscribers")
      .delete()
      .eq("email", normalizedEmail);
    if (deleteError) {
      return { ok: false, error: "Failed to delete your data. Please try again later." };
    }
    return { ok: true };
  }

  // Account subscriptions are sent directly from this table, so deactivate
  // them before changing the legacy subscriber mirror.
  if (accountIds.length > 0) {
    const { error: accountUpdateError } = await supabase
      .from("newsletter_subscriptions")
      .update({ status: "unsubscribed" })
      .in("user_id", accountIds)
      .eq("status", "active");
    if (accountUpdateError) {
      return { ok: false, error: "Failed to update subscription. Please try again later." };
    }
  }

  if (!subscriber || subscriber.status === "unsubscribed") {
    return { ok: true };
  }

  // Mark the legacy subscriber as unsubscribed.
  const { error: updateError } = await supabase
    .from("subscribers")
    .update({ status: "unsubscribed", unsubscribed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", subscriber.id);

  if (updateError) {
    return { ok: false, error: "Failed to update subscription. Please try again later." };
  }

  return { ok: true };
}

Deno.serve(async (request) => {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ── GET: Browser unsubscribe link ──
  if (request.method === "GET") {
    const url = new URL(request.url);
    const email = url.searchParams.get("email");
    const token = url.searchParams.get("token");
    const action = url.searchParams.get("action") === "delete" ? "delete" : "unsubscribe";

    const result = await processUnsubscribe(email, token, action);

    if (result.ok) {
      return htmlPage(
        action === "delete" ? "Your data has been deleted" : "You've been unsubscribed",
        action === "delete"
          ? "Your Dailymattr subscriber record and delivery history have been deleted."
          : "You will no longer receive emails from Dailymattr. If this was a mistake, you can re-subscribe anytime.",
        true,
      );
    }

    return htmlPage("Unsubscribe failed", result.error!, false);
  }

  // ── POST: Programmatic unsubscribe ──
  if (request.method === "POST") {
    try {
      const body = await request.json();
      const { email, token } = body;
      const action = body.action === "delete" ? "delete" : "unsubscribe";
      const result = await processUnsubscribe(email, token, action);

      if (result.ok) {
        return json({ ok: true, message: action === "delete" ? "Your data was deleted." : "Successfully unsubscribed." });
      }

      return json({ ok: false, error: result.error }, 400);
    } catch {
      return json({ error: "Invalid JSON body." }, 400);
    }
  }

  return json({ error: "Method not allowed" }, 405);
});
