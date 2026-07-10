// breaking-alert: hourly operator alert for high-velocity breaking news.
// Reads the breaking_news view (prominence x cross-outlet velocity x fact
// trust, freshness-decayed), takes stories at/over BREAKING_ALERT_THRESHOLD
// (default 70) that were never alerted before, sends ONE compact email to
// BREAKING_ALERT_EMAIL, and stamps breaking_alerted_at so a story alerts once.
//
// Safe by default: if BREAKING_ALERT_EMAIL is unset the function no-ops.
// Admin-gated exactly like backfill-fact-scores (service_role JWT via the
// pg_cron invoke_edge helper) — the public anon key is rejected.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { sendEmail } from "../_shared/mailer.ts";

function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const claims = JSON.parse(atob(b64));
    return typeof claims?.role === "string" ? claims.role : null;
  } catch {
    return null;
  }
}

function isAuthorized(request: Request, serviceKey: string): boolean {
  const bearer = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (jwtRole(bearer) === "service_role") return true;
  if (bearer && bearer === serviceKey) return true;
  return false;
}

function escapeHtml(v = "") {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!isAuthorized(request, serviceRoleKey)) {
    return json({ error: "forbidden: admin credentials required" }, 403);
  }

  const alertEmail = (Deno.env.get("BREAKING_ALERT_EMAIL") ?? "").trim();
  if (!alertEmail.includes("@")) {
    return json({ skipped: true, reason: "BREAKING_ALERT_EMAIL not set — alerts disabled." });
  }
  const threshold = Number(Deno.env.get("BREAKING_ALERT_THRESHOLD") ?? "70");

  const supabase = createClient(requiredEnv("SUPABASE_URL"), serviceRoleKey);

  // Qualifying stories over the threshold...
  const { data: hot, error } = await supabase
    .from("breaking_news")
    .select("id,title,edited_title,summary,edited_summary,source,url,category,status,prominence,source_count,fact_score,breaking_score")
    .gte("breaking_score", threshold)
    .order("breaking_score", { ascending: false })
    .limit(10);
  if (error) return json({ error: error.message }, 500);
  if (!hot || hot.length === 0) return json({ alerted: 0, reason: "nothing over threshold" });

  // ...that were never alerted before.
  const ids = hot.map((h) => h.id);
  const { data: flags } = await supabase
    .from("articles")
    .select("id,breaking_alerted_at")
    .in("id", ids);
  const alreadyAlerted = new Set((flags ?? []).filter((f: any) => f.breaking_alerted_at).map((f: any) => f.id));
  const fresh = hot.filter((h) => !alreadyAlerted.has(h.id));
  if (fresh.length === 0) return json({ alerted: 0, reason: "all already alerted" });

  const items = fresh.map((h) => {
    const title = escapeHtml(h.edited_title || h.title || "");
    const summary = escapeHtml((h.edited_summary || h.summary || "").slice(0, 400));
    const meta = [
      `score ${Math.round(Number(h.breaking_score))}`,
      h.source ? escapeHtml(h.source) : null,
      Number(h.source_count) > 1 ? `${h.source_count} outlets` : null,
      h.fact_score != null ? `fact ${Math.round(Number(h.fact_score))}` : null,
      h.status === "summarized" ? "AWAITING REVIEW" : h.status,
    ].filter(Boolean).join(" · ");
    return `<div style="border:2px solid #111;border-radius:12px;padding:16px 18px;margin:0 0 12px;background:#fff;font-family:Roboto,Arial,sans-serif">
      <p style="margin:0 0 6px;font-size:12px;font-weight:800;color:#c2221e;letter-spacing:.04em">BREAKING · ${meta}</p>
      <h2 style="margin:0 0 8px;font-size:18px;line-height:1.3;color:#111">${title}</h2>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#333">${summary}</p>
      ${h.url ? `<p style="margin:8px 0 0;font-size:13px"><a href="${escapeHtml(h.url)}" style="color:#6d28d9">Source</a></p>` : ""}
    </div>`;
  }).join("");

  const html = `<div style="max-width:640px;margin:0 auto;padding:8px;background:#fcfbf7">
    <p style="font-family:Roboto,Arial,sans-serif;font-size:13px;color:#666;margin:0 0 14px">
      Shortly breaking-news alert — ${fresh.length} stor${fresh.length === 1 ? "y" : "ies"} crossed score ${threshold}.
      Review and approve in the dashboard to publish.
    </p>${items}</div>`;

  const result = await sendEmail({
    to: alertEmail,
    subject: `⚡ Breaking: ${(fresh[0].edited_title || fresh[0].title || "").slice(0, 80)}`,
    html,
  });

  if (result.ok) {
    await supabase.from("articles")
      .update({ breaking_alerted_at: new Date().toISOString() })
      .in("id", fresh.map((h) => h.id));
  }

  return json({ alerted: result.ok ? fresh.length : 0, ok: result.ok, error: result.error ?? null });
});
