import { renderPrivacyFooter } from "./privacy.ts";

// Same banner the daily newsletter uses, so the welcome mail matches the
// editions that follow it.
const BANNER_URL =
  Deno.env.get("SHORTLY_BANNER_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/email-banner-v3.jpg";
const LOGO_URL = "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/dailymattr-primary-logo.png";
const SITE_URL = (Deno.env.get("SHORTLY_SITE_URL") ?? "https://longmattr.com").replace(/\/+$/, "");

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function renderWelcomeEmail(email: string, name: string | null): Promise<string> {
  const greeting = name ? `Hi ${escapeHtml(name)},` : "Hi there,";
  const privacyFooter = await renderPrivacyFooter(email, { includeDelete: false });

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f4f4f1;color:#191919;font-family:Roboto,Arial,sans-serif">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f4f1;padding:24px 12px">
      <tr><td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:680px;background:#fff;border:1px solid #d9d9d4">
          <tr><td style="background:#ffffff;color:#3979ff;padding:12px 22px;font-size:12px;line-height:1.4;font-weight:700">From Team Dailymattr</td></tr>
          <tr><td style="background:#0b1220"><img src="${BANNER_URL}" alt="Dailymattr" width="1280" style="display:block;width:100%;height:auto;border:0"></td></tr>
          <tr><td style="padding:34px 32px 24px">
            <h1 style="margin:0 0 16px;color:#111111;font:700 25px/1.2 Roboto,Arial,sans-serif">${greeting}</h1>
            <p style="margin:0 0 16px;color:#383838;font:16px/1.6 Roboto,Arial,sans-serif">Welcome to the <strong>dailymattr club</strong> - a group of smart, busy people who either don't have the time to stay updated, or whose algorithms simply aren't showing them what matters. Either way, you're covered now.</p>
            <p style="margin:0 0 20px;color:#383838;font:16px/1.6 Roboto,Arial,sans-serif">We bring you the day's news, minus the noise. Five stories that actually mattr, with context, summary and source.</p>
            <p style="margin:0 0 10px;color:#3979ff;font:700 13px/1.2 Roboto,Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase">What to expect</p>
            <p style="margin:0 0 8px;color:#383838;font:16px/1.6 Roboto,Arial,sans-serif">One email, five stories. Every morning.</p>
            <p style="margin:0 0 8px;color:#383838;font:16px/1.6 Roboto,Arial,sans-serif">Handpicked and fact-checked. Straight to the point.</p>
            <p style="margin:0 0 20px;color:#383838;font:16px/1.6 Roboto,Arial,sans-serif">A habit worth keeping - 30 seconds, done before your first coffee.</p>
            <p style="margin:0 0 16px;color:#383838;font:16px/1.6 Roboto,Arial,sans-serif">The first one lands tomorrow morning. If it turns out not to be for you, the unsubscribe link below works instantly and nobody will think anything of it.</p>
            <p style="margin:0;color:#383838;font:16px/1.6 Roboto,Arial,sans-serif">Want to see our standards first? Take a look at our <a href="${SITE_URL}/general" style="color:#3979ff;text-decoration:underline;font-weight:700">NewsStudio</a>.</p>
            <p style="margin:20px 0 0;color:#383838;font:16px/1.6 Roboto,Arial,sans-serif">- Team dailymattr</p>
          </td></tr>
          <tr><td align="center" style="border-top:1px solid #e5e5e1;padding:22px 32px;color:#777;font:13px/1.6 Roboto,Arial,sans-serif"><img src="${LOGO_URL}" alt="dailymattr" width="145" style="display:block;width:145px;max-width:100%;height:auto;margin:0 auto 16px;border:0;outline:none;text-decoration:none">Can be forwarded to others.<br><a href="${SITE_URL}/general" style="display:inline-block;margin-top:14px;background:#3979ff;color:#ffffff;border-radius:22px;padding:10px 18px;text-decoration:none;font:700 14px/1 Roboto,Arial,sans-serif">More news</a>${privacyFooter}</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
