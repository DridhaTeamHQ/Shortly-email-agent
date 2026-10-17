import { sendEmail } from "./mailer.ts";
import { renderWelcomeEmail, WELCOME_SUBJECT } from "./welcome-email.ts";

/** The one way a welcome email is sent: same subject, template and headers
 * whether it comes from the site form, a manual add, a daily batch, or a test. */
export async function sendWelcomeEmail(email: string, name: string | null, opts: { bannerUrl?: string } = {}) {
  return await sendEmail({
    to: email,
    subject: WELCOME_SUBJECT,
    html: await renderWelcomeEmail(email, name, opts),
    // Keeps the List-Unsubscribe + one-click headers (mailer default). We send
    // over 5,000 a day to Gmail, which makes them mandatory, and they give a
    // reader who doesn't want the mail a way out other than "Report spam".
    // A refused send is retried by send-welcomes, never re-routed via Brevo.
    noFallback: true,
  });
}
