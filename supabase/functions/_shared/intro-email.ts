// _shared/intro-email.ts
// One-off announcement for people who were ADDED to the list rather than having
// signed up for it.
//
// This is deliberately not welcome-email.ts. That one says "thanks for
// subscribing", which is false for the 18 colleagues imported from the HR
// spreadsheet and reads badly to anyone who never asked for this.
//
// The honesty here is also a deliverability control, not just manners. SES
// suspends a sender above a 0.1% complaint rate -- about 50 complaints in
// 50,000 -- and the fastest way to earn complaints is mail that looks like it
// arrived from nowhere. So the email says plainly who it is from, why they are
// receiving it, what will arrive and when, and how to stop, with the
// unsubscribe visible rather than buried in the footer.

import { renderPrivacyFooter } from "./privacy.ts";

// Versioned filename rather than overwriting intro-banner.png: raw.github
// caches aggressively, so replacing a file in place can keep serving the old
// image to some recipients for a while. A new path is served correctly the
// moment it exists.
const BANNER_URL =
  Deno.env.get("SHORTLY_INTRO_BANNER_URL") ??
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/intro-banner-v2.jpg";
const LOGO_URL =
  "https://raw.githubusercontent.com/DridhaTeamHQ/Shortly-email-agent/main/assets/dailymattr-primary-logo.png";
const SITE_URL = (Deno.env.get("SHORTLY_SITE_URL") ?? "https://longmattr.com").replace(/\/+$/, "");

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export const INTRO_SUBJECT = "You're on the Dailymattr list — here's what that means";

export async function renderIntroEmail(email: string, name: string | null): Promise<string> {
  const greeting = name ? `Hi ${escapeHtml(String(name).split(" ")[0])},` : "Hi there,";
  const privacyFooter = await renderPrivacyFooter(email);

  return `
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;800&family=Roboto+Serif:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <div style="margin:0;background:#ffffff;padding:0;font-family:Roboto,Arial,sans-serif;color:#191919">
    <div style="max-width:640px;margin:0 auto">

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff">
        <tr>
          <td style="padding:8px 24px;color:#3979ff;font:700 12px/22px Roboto,Arial,sans-serif;letter-spacing:.02em">From Team Dailymattr</td>
        </tr>
      </table>

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#0b1220">
        <tr><td><img src="${BANNER_URL}" alt="Dailymattr" width="1280" style="display:block;width:100%;height:auto;border:0" /></td></tr>
      </table>

      <div style="background:#ffffff;padding:28px 24px 8px">
        <p style="margin:0 0 14px;color:#191919;font-size:20px;line-height:1.3;font-weight:700;font-family:'Roboto Serif',Georgia,serif">${greeting}</p>

        <p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#333">
          Welcome to the <strong>dailymattr</strong> club - a group of smart, busy people who either don't have the time to stay updated, or whose algorithms simply aren't showing them what matters. Either way, you're covered now.
        </p>

        <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#333">
          We bring you the day's news, minus the noise. Five stories that actually mattr, with context, summary and source.
        </p>

        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;background:#f5f7fb;border-radius:10px">
          <tr><td style="padding:18px 20px">
            <p style="margin:0 0 10px;font:700 13px/1.2 Roboto,Arial,sans-serif;color:#3979ff;letter-spacing:.06em;text-transform:uppercase">What to expect</p>
            <p style="margin:0 0 8px;font-size:15px;line-height:1.55;color:#333">📩 <strong>One email, five stories.</strong> Every morning.</p>
            <p style="margin:0 0 8px;font-size:15px;line-height:1.55;color:#333">✅ <strong>Handpicked and fact-checked.</strong> Straight to the point.</p>
            <p style="margin:0;font-size:15px;line-height:1.55;color:#333">☕ <strong>A habit worth keeping.</strong> 30 seconds, done before your first coffee.</p>
          </td></tr>
        </table>

        <p style="margin:0 0 22px;font-size:16px;line-height:1.6;color:#333">
          The first one lands tomorrow morning. If it turns out not to be for you, the unsubscribe link below works instantly and nobody will think anything of it.
        </p>

        <p style="margin:0 0 6px;font-size:15px;line-height:1.6;color:#333">Want to see our standards first? Take a look at our <a href="${SITE_URL}/general" style="color:#3979ff;text-decoration:underline;font-weight:700">newsstudio</a>.</p>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#333">- Team dailymattr</p>
      </div>

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff">
        <tr><td align="center" style="padding:18px 20px 8px;text-align:center;border-top:1px solid #e6e6e6">
          <img src="${LOGO_URL}" alt="dailymattr" width="180" style="display:block;width:180px;max-width:100%;height:auto;margin:0 auto 10px;border:0" />
          <p style="margin:0 0 4px;color:#70707c;font:14px/1.5 Roboto,Arial,sans-serif">Curated news, summarized daily.</p>
          <p style="margin:0;color:#9a9ab0;font:13px/1.5 Roboto,Arial,sans-serif">You're receiving this because you're part of the Dridha team.</p>
          ${privacyFooter}
        </td></tr>
      </table>

    </div>
  </div>`;
}
