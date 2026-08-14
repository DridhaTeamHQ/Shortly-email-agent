import { renderPrivacyFooter } from "./privacy.ts";

const LOGO_URL = "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/dailymattr-primary-logo.png";

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
  const privacyFooter = await renderPrivacyFooter(email);

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f4f4f1;color:#3979ff;font-family:Roboto,Arial,sans-serif">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f4f1;padding:24px 12px">
      <tr><td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:680px;background:#fff;border:1px solid #d9d9d4">
          <tr><td style="background:#ffffff;color:#3979ff;padding:12px 22px;font-size:12px;line-height:1.4;font-weight:700">From Team Dailymattr</td></tr>
          <tr><td style="padding:34px 32px 24px">
            <div style="margin:0 0 24px"><img src="${LOGO_URL}" alt="dailymattr" width="190" style="display:block;width:190px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none"></div>
            <h1 style="margin:0 0 16px;color:#111111;font:700 25px/1.2 Roboto,Arial,sans-serif">${greeting}</h1>
            <p style="margin:0 0 16px;color:#383838;font:16px/1.6 Roboto,Arial,sans-serif">Welcome to dailymattr.</p>
            <p style="margin:0 0 16px;color:#383838;font:16px/1.6 Roboto,Arial,sans-serif">We curate the stories, ideas, and context worth your attention, then turn them into a clear, useful read for your day. No noisy feed, no endless scrolling, and no clickbait.</p>
            <p style="margin:0 0 24px;color:#383838;font:16px/1.6 Roboto,Arial,sans-serif">You will receive concise updates based on the topics you chose, with the important details kept intact and the clutter left out. You can forward any edition to someone who would find it useful.</p>
            <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#3979ff;border-radius:22px"><a href="https://longmattr.com/" style="display:inline-block;padding:12px 22px;color:#fff;text-decoration:none;font:700 14px/1 Roboto,Arial,sans-serif">Explore dailymattr</a></td></tr></table>
          </td></tr>
          <tr><td align="center" style="border-top:1px solid #e5e5e1;padding:22px 32px;color:#777;font:13px/1.6 Roboto,Arial,sans-serif"><img src="${LOGO_URL}" alt="dailymattr" width="145" style="display:block;width:145px;max-width:100%;height:auto;margin:0 auto 16px;border:0;outline:none;text-decoration:none">Can be forwarded to others.<br><a href="https://longmattr.com/general" style="display:inline-block;margin-top:14px;background:#3979ff;color:#ffffff;border-radius:22px;padding:10px 18px;text-decoration:none;font:700 14px/1 Roboto,Arial,sans-serif">More news</a>${privacyFooter}</td></tr>
          <tr><td style="background:#3979ff;color:#fff;padding:16px 22px;font:700 13px/1.4 Roboto,Arial,sans-serif">Read from anywhere</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
