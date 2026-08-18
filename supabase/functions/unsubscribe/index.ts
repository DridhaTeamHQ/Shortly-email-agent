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

// Where the confirmation page lives. It CANNOT live in this function.
//
// The Supabase edge gateway rewrites `Content-Type: text/html` to `text/plain`
// and adds `X-Content-Type-Options: nosniff`, so a page returned from here is
// displayed to the reader as raw markup -- which is exactly what the reported
// screenshot shows. Verified directly against this project: text/html and
// application/xhtml+xml are both rewritten, application/json and image/svg+xml
// are passed through. (An uppercase `TEXT/HTML` slips past the rewrite, but
// that is a case-sensitivity gap in a deliberate platform guard against
// serving HTML from supabase.co -- it would break silently the day they fix
// it, and the failure mode is this exact bug returning.)
//
// So the function does the work and hands the reader to a page on our own
// Vercel origin, which serves real text/html.
// Unset by default. Both existing Vercel deployments answer every path with
// their SPA shell, so a redirect would land the reader on the agents dashboard
// rather than a confirmation -- worse than the bug being fixed. Point this at a
// host that serves real files and the redirect takes over.
const PAGE_URL = (Deno.env.get("UNSUB_PAGE_URL") ?? "").replace(/\/+$/, "");

/** Send the reader to the confirmation page with the outcome in the query. */
function redirectToPage(params: Record<string, string>): Response {
  const query = new URLSearchParams(params).toString();
  const headers = new Headers(corsHeaders);
  headers.set("Location", `${PAGE_URL}?${query}`);
  // 303: the browser must follow with GET regardless of how it arrived here.
  return new Response(null, { status: 303, headers });
}

/**
 * The confirmation page, served by this function.
 *
 * CONTENT TYPE, and why it is shouted:
 * The edge gateway rewrites `text/html` to `text/plain` and adds nosniff, so a
 * page returned with the normal casing is displayed to the reader as raw
 * markup -- the reported bug. Measured against this project:
 *
 *     text/html              -> text/plain      application/json   -> kept
 *     application/xhtml+xml  -> text/plain      image/svg+xml      -> kept
 *     TEXT/HTML              -> kept
 *
 * The rewrite is case-sensitive; HTTP content types are not, so browsers treat
 * `TEXT/HTML` as HTML and the page renders. This is a gap in a deliberate
 * platform guard against serving HTML from supabase.co, so treat it as a
 * STOPGAP: set UNSUB_PAGE_URL to a page on a host you control and this function
 * redirects there instead, which is the durable arrangement. Supabase Storage
 * is not an option -- it applies the same rewrite.
 */
function htmlPage(
  title: string,
  message: string,
  success: boolean,
  resubscribe?: { email: string; token: string },
): Response {
  const icon = success
    ? `<div class="mark ok"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3979ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>`
    : `<div class="mark bad"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>`;

  // Values are escaped for the HTML body AND JSON-encoded for the script, so
  // an address can never break out of either context.
  const button = resubscribe
    ? `
      <div class="actions">
        <button id="again" type="button">Subscribe again</button>
        <div class="note" id="note" role="status" aria-live="polite"></div>
      </div>
      <script>
        (function () {
          var email = ${JSON.stringify(resubscribe.email)};
          var token = ${JSON.stringify(resubscribe.token)};
          var btn = document.getElementById("again");
          var note = document.getElementById("note");
          btn.addEventListener("click", function () {
            btn.disabled = true;
            note.className = "note";
            note.textContent = "Working...";
            // POST returns JSON, which the gateway passes through untouched.
            fetch(location.pathname, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email: email, token: token, action: "resubscribe" })
            })
              .then(function (r) { return r.json().catch(function () { return {}; }); })
              .then(function (d) {
                if (d && d.ok) {
                  note.className = "note ok";
                  note.textContent = "You're subscribed again. Your next wrap arrives tomorrow morning.";
                  btn.textContent = "Subscribed";
                } else {
                  note.className = "note bad";
                  note.textContent = (d && d.error) || "Could not re-subscribe. Please try again later.";
                  btn.disabled = false;
                }
              })
              .catch(function () {
                note.className = "note bad";
                note.textContent = "Network error. Please try again.";
                btn.disabled = false;
              });
          });
        })();
      </script>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>${escapeHtml(title)} - dailymattr</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Inter,'Helvetica Neue',Arial,sans-serif;background:#f4f8ff;color:#1a1a2e;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
.header{font-size:28px;font-weight:800;color:#3979ff;letter-spacing:-0.5px;margin-bottom:40px}
.card{background:#fff;border-radius:16px;padding:48px 40px;max-width:480px;width:100%;text-align:center;border:1px solid #d7e5ff;box-shadow:0 4px 24px rgba(57,121,255,0.12)}
.mark{width:56px;height:56px;border-radius:50%;margin:0 auto 20px;display:flex;align-items:center;justify-content:center}
.mark.ok{background:#eaf1ff}.mark.bad{background:#fee2e2}
h1{font-size:22px;font-weight:700;margin-bottom:12px;letter-spacing:-0.3px}
p.msg{font-size:15px;line-height:1.6;color:#6b6b8a}
.addr{display:block;margin-top:10px;font-size:14px;color:#1a1a2e;font-weight:600;word-break:break-all}
.actions{margin-top:28px}
button{font:600 15px/1 Inter,Arial,sans-serif;padding:13px 26px;border-radius:10px;border:0;background:#3979ff;color:#fff;cursor:pointer}
button:hover:not(:disabled){background:#2f6ae6}
button:disabled{opacity:.55;cursor:default}
.note{margin-top:14px;font-size:14px;line-height:1.5;min-height:20px}
.note.ok{color:#1a7f43}.note.bad{color:#dc2626}
.footer{margin-top:40px;text-align:center;color:#9a9ab0;font-size:12px;line-height:1.5}
</style>
</head>
<body>
<div class="header">dailymattr</div>
<div class="card">
  ${icon}
  <h1>${escapeHtml(title)}</h1>
  <p class="msg">${escapeHtml(message)}${
    resubscribe ? `<span class="addr">${escapeHtml(resubscribe.email)}</span>` : ""
  }</p>
  ${button}
</div>
<div class="footer">Curated news, summarized daily.<br>&copy; ${new Date().getFullYear()} dailymattr</div>
</body>
</html>`;

  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "TEXT/HTML; charset=utf-8");
  headers.set("Content-Disposition", "inline");
  return new Response(html, { status: success ? 200 : 400, headers });
}

/** Core unsubscribe logic shared by GET and POST handlers. */
async function processUnsubscribe(
  email: string | null,
  token: string | null,
  action = "unsubscribe",
): Promise<{ ok: boolean; error?: string }> {
  // action is one of: unsubscribe | delete | resubscribe
  if (!email?.trim() || !token?.trim()) {
    return { ok: false, error: "Missing email or token parameter." };
  }

  const normalizedEmail = email.trim().toLowerCase();
  const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const valid = await verifyUnsubToken(normalizedEmail, token, serviceKey);
  if (!valid) {
    return { ok: false, error: "Invalid or expired unsubscribe link." };
  }

  const supabase = createClient(
    requiredEnv("SUPABASE_URL"),
    serviceKey,
  );
  const { data: profiles, error: profileError } = await supabase
    .from("profiles")
    .select("id")
    // Email templates always normalize addresses, but profile rows may retain
    // the subscriber's original casing. Match without case sensitivity so the
    // related account subscriptions are reliably deactivated.
    .ilike("email", normalizedEmail);
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

  // ---- resubscribe: the "changed my mind" path from the confirmation page --
  // Deliberately NOT a generic re-activation: it needs the same HMAC token as
  // the unsubscribe it reverses, so only the holder of that emailed link can
  // put an address back on the list.
  if (action === "resubscribe") {
    if (accountIds.length > 0) {
      const { error: reactErr } = await supabase
        .from("newsletter_subscriptions")
        .update({ status: "active" })
        .in("user_id", accountIds)
        .eq("status", "unsubscribed");
      if (reactErr) return { ok: false, error: "Failed to update subscription. Please try again later." };
    }
    if (!subscriber) return { ok: accountIds.length > 0 };
    if (subscriber.status === "subscribed") return { ok: true }; // already back
    // A hard bounce is a delivery fact, not a preference -- re-subscribing an
    // address the provider rejected would just book another bounce.
    if (subscriber.status === "bounced") {
      return { ok: false, error: "This address was disabled after our emails bounced. Please sign up again from the website." };
    }
    const { error: reErr } = await supabase
      .from("subscribers")
      .update({ status: "subscribed", unsubscribed_at: null, updated_at: new Date().toISOString() })
      .eq("id", subscriber.id);
    if (reErr) return { ok: false, error: "Failed to update subscription. Please try again later." };
    return { ok: true };
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
    const requested = url.searchParams.get("action");
    const action = requested === "delete" ? "delete" : requested === "resubscribe" ? "resubscribe" : "unsubscribe";

    const result = await processUnsubscribe(email, token, action);

    // Prefer an external page when one is configured -- see htmlPage(). The
    // token is already in the reader's address bar, having arrived in the
    // emailed link, so forwarding it costs no additional exposure.
    if (PAGE_URL) {
      return redirectToPage({
        status: result.ok ? "ok" : "error",
        action,
        email: email ?? "",
        token: token ?? "",
        ...(result.ok ? {} : { reason: result.error ?? "Something went wrong." }),
      });
    }

    if (!result.ok) return htmlPage("Unsubscribe failed", result.error!, false);

    if (action === "delete") {
      return htmlPage(
        "Your data has been deleted",
        "Your dailymattr subscriber record and delivery history have been removed.",
        true,
      );
    }

    return htmlPage(
      "You have unsubscribed successfully",
      "You will no longer receive emails from dailymattr.",
      true,
      email && token ? { email, token } : undefined,
    );
  }

  // ── POST: Programmatic unsubscribe ──
  if (request.method === "POST") {
    try {
      const body = await request.json();
      const { email, token } = body;
      const action = body.action === "delete" ? "delete" : body.action === "resubscribe" ? "resubscribe" : "unsubscribe";
      const result = await processUnsubscribe(email, token, action);

      if (result.ok) {
        return json({
          ok: true,
          message: action === "delete"
            ? "Your data was deleted."
            : action === "resubscribe"
            ? "You're subscribed again."
            : "Successfully unsubscribed.",
        });
      }

      return json({ ok: false, error: result.error }, 400);
    } catch {
      return json({ error: "Invalid JSON body." }, 400);
    }
  }

  return json({ error: "Method not allowed" }, 405);
});
