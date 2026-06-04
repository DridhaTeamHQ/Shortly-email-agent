// Transactional email helper.
// Prefers Amazon SES when AWS credentials are configured.
// Falls back to Brevo HTTP API to avoid breaking existing live sends.

import { requiredEnv } from "./http.ts";
import { SESv2Client, SendEmailCommand } from "npm:@aws-sdk/client-sesv2";

type SendOpts = {
  to: string;
  subject: string;
  html: string;
};

export async function sendEmail(opts: SendOpts) {
  const fromRaw = Deno.env.get("FROM_EMAIL") ?? "Shortly Dailywrap <dailywrap@shortlyindia.com>";

  const match = fromRaw.match(/^(.+?)\s*<(.+?)>$/);
  const senderName = match?.[1] ?? "Shortly Dailywrap";
  const senderEmail = match?.[2] ?? fromRaw;

  const awsKey = Deno.env.get("AWS_ACCESS_KEY_ID");
  const awsSecret = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const awsRegion = Deno.env.get("AWS_REGION");

  if (awsKey && awsSecret && awsRegion) {
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
        Content: {
          Simple: {
            Subject: { Data: opts.subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: opts.html, Charset: "UTF-8" },
            },
          },
        },
      }));

      return {
        ok: true,
        messageId: response.MessageId,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        messageId: null,
        error: error instanceof Error ? error.message : "SES send failed",
      };
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
    }),
  });

  const body = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    messageId: body.messageId as string | undefined,
    error: response.ok ? null : (body.message ?? `Brevo ${response.status}`),
  };
}
