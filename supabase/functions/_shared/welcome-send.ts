import { sendEmail } from "./mailer.ts";
import { renderWelcomeEmail, WELCOME_SUBJECT } from "./welcome-email.ts";

/** The one way a welcome email is sent: same subject, template and headers
 * whether it comes from the site form, a manual add, a daily batch, or a test. */
export async function sendWelcomeEmail(email: string, name: string | null) {
  return await sendEmail({
    to: email,
    subject: WELCOME_SUBJECT,
    html: await renderWelcomeEmail(email, name),
    // One-to-one mail: no List-Unsubscribe headers (see mailer.ts).
    bulk: false,
  });
}
