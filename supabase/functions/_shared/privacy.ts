import { requiredEnv } from "./http.ts";
import { generateUnsubToken } from "./unsub.ts";

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** The reader's personal unsubscribe (or "delete my data") link on our own
 * domain. The page forwards email + token to the unsubscribe function. Links
 * that stay on the sender's domain read as more trustworthy to Gmail than ones
 * pointing at supabase.co. The one-click List-Unsubscribe header keeps the
 * function URL (see mailer.ts). */
export async function unsubscribeUrl(email: string, action: "unsubscribe" | "delete" = "unsubscribe"): Promise<string> {
  const normalizedEmail = email.trim().toLowerCase();
  const base = (Deno.env.get("UNSUB_LINK_BASE") ?? "https://www.dailymattr.com/unsubscribe").replace(/\/+$/, "");
  const token = await generateUnsubToken(normalizedEmail, requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  return `${base}?email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(token)}&action=${action}`;
}

/** Secure, per-recipient links for the email footer. */
export async function renderPrivacyFooter(
  email: string,
  { includeDelete = true }: { includeDelete?: boolean } = {},
): Promise<string> {
  const unsubscribeLink = await unsubscribeUrl(email);
  const deleteUrl = await unsubscribeUrl(email, "delete");
  const deleteLink = includeDelete
    ? `
    <span style="color:#c4c4cf">&nbsp;|&nbsp;</span>
    <a href="${escapeHtml(deleteUrl)}" style="color:#8b8b9d;text-decoration:underline">Delete my data</a>`
    : "";

  return `<p style="margin:12px 0 0;color:#8b8b9d;font-size:12px;line-height:1.5;font-family:Roboto,Arial,sans-serif">
    <a href="${escapeHtml(unsubscribeLink)}" style="color:#3979ff;text-decoration:underline">Unsubscribe</a>
    ${deleteLink}
  </p>`;
}
