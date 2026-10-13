// Readable status for each never-send (email_suppressions) reason, and a
// one-line "why". Shown in the dashboard download, the daily report email and
// the Excel reports, so the owner sees WHY an address will never be mailed.
// Keep in sync with scripts/never-send-report.py.
export const NEVER_SEND_STATUS: Record<string, string> = {
  precheck_domain: "precheck-domain (not an allowed domain)",
  precheck_validity: "precheck-validity",
  ses_medium_confidence: "medium-overall-confidence (SES)",
  ses_low_confidence: "low-overall-confidence (SES)",
  ses_auto_validation: "ses-auto-validation (blocked before sending)",
  hard_bounce: "hard-bounce",
  repeated_soft_bounce: "repeated-soft-bounce",
  complaint: "spam-complaint",
  unsubscribed: "unsubscribed",
  manual: "manual",
};

export const NEVER_SEND_WHY: Record<string, string> = {
  precheck_domain: "Not an @gmail.com address. Only @gmail.com is accepted.",
  precheck_validity: "Failed our pre-check (shared mailbox, impossible Gmail name, random-looking name or misspelled domain).",
  ses_medium_confidence: "SES rated the address MEDIUM - not confident the mailbox exists. Only HIGH is mailed.",
  ses_low_confidence: "SES rated the address LOW - very likely does not exist.",
  ses_auto_validation: "SES Auto Validation blocked it before sending (below HIGH).",
  hard_bounce: "The mailbox rejected our email - the account does not exist or is closed.",
  repeated_soft_bounce: "Bounced 5+ times in 14 days (e.g. mailbox full) with nothing delivered.",
  complaint: "The person marked our email as spam.",
  unsubscribed: "The person unsubscribed.",
  manual: "Added by the team.",
};

// Entries written before the 2026-10-13 status update carry their real status
// in the detail text; report them under the status they now have.
export function neverSendReason(row: { reason: string; detail?: string | null }): string {
  if (row.reason === "manual" && (row.detail ?? "").startsWith("precheck-domain")) return "precheck_domain";
  if (row.reason === "hard_bounce" && row.detail === "EmailValidationSuppressed") return "ses_auto_validation";
  return row.reason;
}

export function neverSendStatus(reason: string): string {
  return NEVER_SEND_STATUS[reason] ?? reason;
}

export function neverSendWhy(reason: string): string {
  return NEVER_SEND_WHY[reason] ?? "";
}
