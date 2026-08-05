import { renderPrivacyFooter } from "./privacy.ts";

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
  <body style="margin:0;background:#f4f4f1;color:#202020;font-family:Roboto,Arial,sans-serif">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f4f1;padding:24px 12px">
      <tr><td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:680px;background:#fff;border:1px solid #d9d9d4">
          <tr><td style="background:#050505;color:#fff;padding:12px 22px;font-size:12px;line-height:1.4">From the Daily Mattr Team</td></tr>
          <tr><td style="padding:34px 32px 24px">
            <div style="margin:0 0 24px;color:#202020;font:700 28px/1 'Roboto Serif',Georgia,serif">DailyMattr<sup style="font-size:11px">®</sup></div>
            <h1 style="margin:0 0 16px;color:#202020;font:700 25px/1.2 'Roboto Serif',Georgia,serif">${greeting}</h1>
            <p style="margin:0 0 16px;color:#383838;font:16px/1.6 Roboto,Arial,sans-serif">Welcome to Daily Mattr.</p>
            <p style="margin:0 0 16px;color:#383838;font:16px/1.6 Roboto,Arial,sans-serif">We curate the stories, ideas, and context worth your attention, then turn them into a clear, useful read for your day. No noisy feed, no endless scrolling, and no clickbait.</p>
            <p style="margin:0 0 24px;color:#383838;font:16px/1.6 Roboto,Arial,sans-serif">You will receive concise updates based on the topics you chose, with the important details kept intact and the clutter left out. You can forward any edition to someone who would find it useful.</p>
            <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#202020;border-radius:22px"><a href="https://longmattr.com/" style="display:inline-block;padding:12px 22px;color:#fff;text-decoration:none;font:700 14px/1 Roboto,Arial,sans-serif">Explore Daily Mattr</a></td></tr></table>
          </td></tr>
          <tr><td style="border-top:1px solid #e5e5e1;padding:22px 32px;color:#777;font:13px/1.6 Roboto,Arial,sans-serif">Curated news, summarized daily.<br>You are receiving this because you subscribed to Daily Mattr.${privacyFooter}</td></tr>
          <tr><td style="background:#050505;color:#fff;padding:16px 22px;font:700 13px/1.4 Roboto,Arial,sans-serif">Read from anywhere</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
