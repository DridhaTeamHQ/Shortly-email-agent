// Transactional email helper.
// Prefers Amazon SES when AWS credentials are configured.
// Falls back to Brevo HTTP API to avoid breaking existing live sends.

import { requiredEnv } from "./http.ts";
import { generateUnsubToken } from "./unsub.ts";
import { SESv2Client, SendEmailCommand } from "npm:@aws-sdk/client-sesv2";

type SendOpts = {
  to: string;
  subject: string;
  html: string;
  provider?: "ses" | "brevo";
};

/* One-click unsubscribe headers.
 *
 * Gmail and Yahoo expect bulk mail to carry BOTH List-Unsubscribe and
 * List-Unsubscribe-Post. Mail without them reads as unsolicited and is filed
 * as spam regardless of how well the domain authenticates -- which is what was
 * happening here: DKIM, SPF and DMARC all pass, and the mail still landed in
 * spam, because every message went out with no unsubscribe header at all.
 *
 * The URL is the same HMAC-signed endpoint the footer link already uses, so
 * this exposes no new surface. Building it must never break a send, hence the
 * catch: a missing header costs placement, a thrown error costs the email.
 */
async function unsubscribeHeaders(to: string) {
  try {
    const base = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!base || !key) return [];
    const email = to.trim().toLowerCase();
    const token = await generateUnsubToken(email, key);
    const url = `${base}/functions/v1/unsubscribe?email=${encodeURIComponent(email)}` +
      `&token=${encodeURIComponent(token)}&action=unsubscribe`;
    const headers = [{ Name: "List-Unsubscribe", Value: `<${url}>` }];

    /* List-Unsubscribe-Post turns the mailbox provider's unsubscribe button
     * into a silent one-click POST. Only advertise it once the unsubscribe
     * function can actually SERVE that POST -- it reads credentials from the
     * query string and tolerates a non-JSON body. Advertising one-click and
     * then failing the click is penalised harder than not offering it, so this
     * stays behind a flag that is flipped after that function is deployed:
     *   supabase secrets set ONE_CLICK_UNSUB=1
     * Without the flag the header below still gives Gmail and Yahoo a working
     * unsubscribe link (they fall back to opening the URL). */
    if (Deno.env.get("ONE_CLICK_UNSUB") === "1") {
      headers.push({ Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" });
    }
    return headers;
  } catch (error) {
    console.error("could not build unsubscribe headers", error);
    return [];
  }
}

export async function sendEmail(opts: SendOpts) {
  const fromRaw = Deno.env.get("FROM_EMAIL") ?? "Dailywrap <team@dailymattr.com>";

  const match = fromRaw.match(/^(.+?)\s*<(.+?)>$/);
  const senderName = match?.[1] ?? "Dailywrap";
  const senderEmail = match?.[2] ?? fromRaw;

  const awsKey = Deno.env.get("AWS_ACCESS_KEY_ID");
  const awsSecret = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const awsRegion = Deno.env.get("AWS_REGION");
  // Set SES_CONFIGURATION_SET once the configuration set exists in AWS and
  // every send starts emitting delivery/bounce/complaint events. Until then
  // the field is simply omitted.
  const configurationSet = Deno.env.get("SES_CONFIGURATION_SET");

  const headers = await unsubscribeHeaders(opts.to);

  if (opts.provider !== "brevo" && awsKey && awsSecret && awsRegion) {
    try {
      const client = new SESv2Client({
        region: awsRegion,
        credentials: {
          accessKeyId: awsKey,
          secretAccessKey: awsSecret,
        },
      });

      const response = await client.send(new SendEmailCommand({
        FromEmailAddress: `${senderName} <${senderEmail}>`,
        Destination: {
          ToAddresses: [opts.to],
        },
        ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
        Content: {
          Simple: {
            Subject: { Data: opts.subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: opts.html, Charset: "UTF-8" },
            },
            ...(headers.length ? { Headers: headers } : {}),
          },
        },
      }));

      return {
        ok: true,
        messageId: response.MessageId,
        // Which service actually carried the mail. Without this a caller
        // cannot tell an SES send from the silent Brevo fallback below, and
        // an unexplained "sent" is untraceable in either provider's console.
        provider: "ses" as const,
        from: `${senderName} <${senderEmail}>`,
        error: null,
      };
    } catch (error) {
      // Keep Brevo as an emergency fallback while SES is being configured or
      // temporarily rejects a message.
      console.error("SES send failed; falling back to Brevo", error);
    }
  }

  const apiKey = requiredEnv("SMTP_PASS");

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
      ...(headers.length
        ? {
          headers: Object.fromEntries(headers.map((h) => [h.Name, h.Value])),
        }
        : {}),
    }),
  });

  const body = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    messageId: body.messageId as string | undefined,
    provider: "brevo" as const,
    from: `${senderName} <${senderEmail}>`,
    error: response.ok ? null : (body.message ?? `Brevo ${response.status}`),
  };
}
