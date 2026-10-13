// SES Email Validation for single addresses (GetEmailAddressInsights).
//
// Billed by SES per address, so it is only used to explain addresses that SES
// Auto Validation has ALREADY blocked: it turns "ses_auto_validation" on the
// never-send list into medium- or low-confidence, with the mailbox verdict.
import { GetEmailAddressInsightsCommand, SESv2Client } from "npm:@aws-sdk/client-sesv2";
import { requiredEnv } from "./http.ts";

export type Insight = {
  isValid: string | null;        // HIGH | MEDIUM | LOW
  mailboxExists: string | null;  // HIGH | MEDIUM | LOW
};

let client: SESv2Client | null = null;

export async function emailInsight(email: string): Promise<Insight> {
  client ??= new SESv2Client({
    region: requiredEnv("AWS_REGION"),
    credentials: {
      accessKeyId: requiredEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("AWS_SECRET_ACCESS_KEY"),
    },
  });
  const r = await client.send(new GetEmailAddressInsightsCommand({ EmailAddress: email }));
  // deno-lint-ignore no-explicit-any
  const v = (r as any).MailboxValidation ?? {};
  return {
    isValid: v.IsValid?.ConfidenceVerdict ?? null,
    mailboxExists: v.Evaluations?.MailboxExists?.ConfidenceVerdict ?? null,
  };
}

// deno-lint-ignore no-explicit-any
type Client = any;

/** Relabel up to `limit` ses_auto_validation entries with SES's own verdict. */
export async function labelBlockedAddresses(supabase: Client, limit = 25) {
  const { data, error } = await supabase
    .from("email_suppressions")
    .select("email,source,created_at")
    .eq("reason", "ses_auto_validation")
    .order("created_at")
    .limit(limit);
  if (error) throw new Error(error.message);
  let labelled = 0;
  for (const row of (data ?? []) as Array<{ email: string; source: string; created_at: string }>) {
    let insight: Insight;
    try {
      insight = await emailInsight(row.email);
    } catch (e) {
      console.error(JSON.stringify({ tag: "ses-insights", email: row.email, error: String(e).slice(0, 200) }));
      continue;
    }
    // HIGH now (it changed since the send) keeps the generic label; it stays
    // blocked either way -- an address SES refused once is not retried.
    const reason = insight.isValid === "LOW" ? "ses_low_confidence"
      : insight.isValid === "MEDIUM" ? "ses_medium_confidence"
      : null;
    if (!reason) continue;
    const detail = `SES overall validity ${insight.isValid}, mailbox exists ${insight.mailboxExists ?? "?"}`;
    const { error: insErr } = await supabase.from("email_suppressions").upsert(
      { email: row.email, reason, detail, source: row.source, created_at: row.created_at },
      { onConflict: "email,reason", ignoreDuplicates: true },
    );
    if (insErr) continue;
    await supabase.from("email_suppressions").delete().eq("email", row.email).eq("reason", "ses_auto_validation");
    labelled++;
  }
  return labelled;
}
