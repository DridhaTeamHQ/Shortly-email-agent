// Brevo transactional email via HTTP API.
// Uses the same SMTP key as api-key header.

import { requiredEnv } from "./http.ts";

type SendOpts = {
  to: string;
  subject: string;
  html: string;
};

export async function sendEmail(opts: SendOpts) {
  const apiKey = requiredEnv("SMTP_PASS");
  const fromRaw = Deno.env.get("FROM_EMAIL") ?? "Shortly Digest <digest@example.com>";

  const match = fromRaw.match(/^(.+?)\s*<(.+?)>$/);
  const senderName = match?.[1] ?? "Shortly Digest";
  const senderEmail = match?.[2] ?? fromRaw;

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: senderName, email: senderEmail },
      to: [{ email: opts.to }],
      subject: opts.subject,
      htmlContent: opts.html,
    }),
  });

  const body = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    messageId: body.messageId as string | undefined,
    error: response.ok ? null : (body.message ?? `Brevo ${response.status}`),
  };
}
