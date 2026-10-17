// welcome-test
//
// Sends the welcome email exactly as `subscribers` would, to at most five
// hand-picked addresses, so a template or header change can be checked in a
// real inbox before the live welcome path is redeployed. It reads and writes no
// subscriber rows. Same requireAgent() gate as the other operational functions.
//
//   POST {"recipients":[{"email":"a@b.com","name":"Aakash"}]}
import { corsHeaders, json } from "../_shared/http.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { sendWelcomeEmail } from "../_shared/welcome-send.ts";
import { BANNER_URL_V3, WELCOME_SUBJECT } from "../_shared/welcome-email.ts";
import { suppressedAmong } from "../_shared/suppression.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requiredEnv } from "../_shared/http.ts";

const MAX_RECIPIENTS = 5;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const denied = await requireAgent(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const recipients = (Array.isArray(body?.recipients) ? body.recipients : [])
    .map((r: { email?: unknown; name?: unknown; banner?: unknown }) => ({
      email: String(r?.email ?? "").trim().toLowerCase(),
      name: r?.name ? String(r.name).trim() : null,
      // Test-only: "v3" sends the previous banner (no QR code) for A/B checks.
      banner: r?.banner === "v3" ? "v3" : "current",
    }))
    .filter((r: { email: string }) => EMAIL_PATTERN.test(r.email));
  if (recipients.length === 0 || recipients.length > MAX_RECIPIENTS) {
    return json({ error: `Provide between 1 and ${MAX_RECIPIENTS} recipients.` }, 400);
  }

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const suppressed = await suppressedAmong(supabase, recipients.map((r: { email: string }) => r.email));
  const results = [];
  for (const { email, name, banner } of recipients) {
    if (suppressed.has(email)) {
      results.push({ email, ok: false, provider: null, messageId: null, error: "on the suppression list -- not sent" });
      continue;
    }
    const result = await sendWelcomeEmail(email, name, banner === "v3" ? { bannerUrl: BANNER_URL_V3 } : {});
    results.push({ email, banner, ok: result.ok, provider: result.provider, messageId: result.messageId ?? null, error: result.error });
  }
  return json({ ok: true, subject: WELCOME_SUBJECT, results });
});
