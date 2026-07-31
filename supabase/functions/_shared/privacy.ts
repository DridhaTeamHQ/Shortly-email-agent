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

/** Secure, per-recipient links for the email footer. */
export async function renderPrivacyFooter(email: string): Promise<string> {
  const normalizedEmail = email.trim().toLowerCase();
  const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const base = `${requiredEnv("SUPABASE_URL")}/functions/v1/unsubscribe`;
  const token = await generateUnsubToken(normalizedEmail, serviceKey);
  const query = `email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(token)}`;
  const unsubscribeUrl = `${base}?${query}&action=unsubscribe`;
  const deleteUrl = `${base}?${query}&action=delete`;

  return `<p style="margin:12px 0 0;color:#8b8b9d;font-size:12px;line-height:1.5;font-family:Roboto,Arial,sans-serif">
    <a href="${escapeHtml(unsubscribeUrl)}" style="color:#6d28d9;text-decoration:underline">Unsubscribe</a>
    <span style="color:#c4c4cf">&nbsp;|&nbsp;</span>
    <a href="${escapeHtml(deleteUrl)}" style="color:#8b8b9d;text-decoration:underline">Delete my data</a>
  </p>`;
}
