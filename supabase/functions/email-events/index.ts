// email-events: ingest Amazon SES delivery notifications (via SNS) so the
// system can tell "the provider accepted it" from "it actually arrived".
//
// Without this, article_deliveries.status='sent' only means SES returned a
// MessageId. Two load tests on 2026-08-15 both reported sent:100/failed:0 while
// delivering 0 and 67 respectively.
//
// SNS cannot send an Authorization header, so this function runs with
// verify_jwt=false and is gated on a shared secret in the query string:
//     https://<project>.functions.supabase.co/email-events?token=<SES_EVENT_WEBHOOK_SECRET>
// It FAILS CLOSED: with no secret configured, every request is rejected.
//
// Handles both SNS envelope types:
//   SubscriptionConfirmation -> auto-confirms by fetching SubscribeURL
//   Notification             -> records the SES event
//
// Effects, all idempotent:
//   * append to email_events (audit, never mutated)
//   * stamp delivered_at / bounced_at / complained_at on article_deliveries
//   * PERMANENT bounce  -> subscribers.status = 'bounced'
//     complaint         -> subscribers.status = 'unsubscribed'
//   Both are automatically excluded from future sends, because every send
//   filters on status = 'subscribed'. No send-path change required.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// SES uses "eventType" (event publishing) or "notificationType" (legacy topic
// notifications). Normalise both to a lowercase verb.
function normalizeType(m: Record<string, unknown>): string {
  const raw = String(m.eventType ?? m.notificationType ?? "unknown");
  return raw.toLowerCase();
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // ---- gate (fail closed) ----
  const secret = Deno.env.get("SES_EVENT_WEBHOOK_SECRET")?.trim() ?? "";
  if (!secret) {
    return json({ error: "SES_EVENT_WEBHOOK_SECRET is not configured" }, 503);
  }
  const token = new URL(request.url).searchParams.get("token")?.trim() ?? "";
  if (!timingSafeEqual(token, secret)) {
    return json({ error: "forbidden" }, 403);
  }

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const bodyText = await request.text();
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(bodyText);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const envelopeType = String(envelope.Type ?? "");

  // ---- SNS handshake: confirm the subscription automatically ----
  if (envelopeType === "SubscriptionConfirmation") {
    const url = String(envelope.SubscribeURL ?? "");
    // Only ever fetch an amazonaws.com URL from the envelope.
    let host = "";
    try { host = new URL(url).hostname; } catch { /* ignore */ }
    if (!/\.amazonaws\.com$/i.test(host)) {
      return json({ error: "refusing to confirm a non-AWS SubscribeURL" }, 400);
    }
    const res = await fetch(url);
    await supabase.from("email_events").insert({
      event_type: "subscription-confirmation",
      raw: { topicArn: envelope.TopicArn ?? null, confirmed: res.ok },
    });
    return json({ ok: true, confirmed: res.ok });
  }

  if (envelopeType !== "Notification") {
    return json({ ok: true, ignored: envelopeType || "no-type" });
  }

  // ---- SES event payload lives as a JSON string inside Message ----
  let msg: Record<string, unknown>;
  try {
    msg = typeof envelope.Message === "string" ? JSON.parse(envelope.Message) : (envelope.Message as Record<string, unknown>) ?? {};
  } catch {
    return json({ error: "unparseable SNS Message" }, 400);
  }

  const kind = normalizeType(msg);
  const mail = (msg.mail ?? {}) as Record<string, unknown>;
  const messageId = String(mail.messageId ?? "") || null;

  const bounce = (msg.bounce ?? {}) as Record<string, unknown>;
  const complaint = (msg.complaint ?? {}) as Record<string, unknown>;
  const delivery = (msg.delivery ?? {}) as Record<string, unknown>;

  const bounceType = bounce.bounceType ? String(bounce.bounceType) : null;
  const bounceSub = bounce.bounceSubType ? String(bounce.bounceSubType) : null;

  // Which addresses does this event concern?
  type R = { emailAddress?: string; diagnosticCode?: string };
  const recipients: Array<{ email: string; diagnostic: string | null }> = [];
  const push = (e: unknown, d: unknown) => {
    const addr = String(e ?? "").trim().toLowerCase();
    if (addr) recipients.push({ email: addr, diagnostic: d ? String(d) : null });
  };
  if (kind === "bounce") {
    for (const r of (bounce.bouncedRecipients as R[] ?? [])) push(r.emailAddress, r.diagnosticCode);
  } else if (kind === "complaint") {
    for (const r of (complaint.complainedRecipients as R[] ?? [])) push(r.emailAddress, null);
  } else if (kind === "delivery") {
    for (const r of (delivery.recipients as string[] ?? [])) push(r, null);
  }
  if (recipients.length === 0) {
    for (const r of (mail.destination as string[] ?? [])) push(r, null);
  }

  const now = new Date().toISOString();
  let deliveriesUpdated = 0;
  let subscribersFlagged = 0;

  for (const r of recipients) {
    // 1. audit row (append-only)
    await supabase.from("email_events").insert({
      provider: "ses",
      message_id: messageId,
      email: r.email,
      event_type: kind,
      bounce_type: bounceType,
      bounce_sub: bounceSub,
      diagnostic: r.diagnostic,
      raw: msg,
    });

    // 2. stamp the outcome on the delivery log
    if (messageId) {
      const patch: Record<string, unknown> = { last_event: kind };
      if (kind === "delivery") patch.delivered_at = now;
      if (kind === "bounce") { patch.bounced_at = now; patch.bounce_type = bounceType; patch.diagnostic = r.diagnostic; }
      if (kind === "complaint") patch.complained_at = now;

      const { data } = await supabase
        .from("article_deliveries")
        .update(patch)
        .eq("provider_message_id", messageId)
        .select("id");
      deliveriesUpdated += data?.length ?? 0;
    }

    // 3. suppress bad addresses. Transient bounces (full mailbox, throttling)
    //    are NOT suppressed -- they usually recover.
    const suppressTo =
      kind === "bounce" && bounceType === "Permanent" ? "bounced"
      : kind === "complaint" ? "unsubscribed"
      : null;

    if (suppressTo) {
      const { data } = await supabase
        .from("subscribers")
        .update({ status: suppressTo, updated_at: now })
        .eq("email", r.email)
        .neq("status", suppressTo)
        .select("id");
      subscribersFlagged += data?.length ?? 0;
    }
  }

  return json({
    ok: true,
    event: kind,
    messageId,
    recipients: recipients.length,
    deliveriesUpdated,
    subscribersFlagged,
  });
});
