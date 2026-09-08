// _shared/email-verify.ts
// Pre-send email verification, used by verify-subscribers (batch), and the
// subscribers function (add / import). Checks, in order of cost:
//   1. syntax        -- RFC-ish shape, length caps, no consecutive dots
//   2. typo domains  -- gmial.com etc. -> invalid with a suggestion
//   3. disposable    -- throwaway providers -> invalid
//   4. role account  -- info@/noreply@ etc. -> risky (deliverable but low value)
//   5. DNS           -- MX lookup, falling back to A/AAAA
//
// Verdicts:
//   valid    -- passed everything we can check without an SMTP probe
//   risky    -- deliverability uncertain (role account, A-record-only domain,
//               DNS timeout). NOT suppressed; surfaced in the dashboard.
//   invalid  -- provably unworkable (syntax, disposable, domain doesn't exist).
//
// IMPORTANT: transient DNS failures must NEVER produce 'invalid' — a resolver
// hiccup would silently purge real subscribers. Only NXDOMAIN (domain truly
// absent) invalidates at the DNS stage.

export type EmailVerdict = "valid" | "risky" | "invalid";

export type VerifyResult = {
  email: string;
  verdict: EmailVerdict;
  reason: string;
};

const COMMON_EMAIL_DOMAIN_TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmaill.com": "gmail.com",
  "googlemail.co": "googlemail.com",
  "yaho.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "yahoo.co": "yahoo.com",
  "hotmial.com": "hotmail.com",
  "hotmal.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "outlok.com": "outlook.com",
  "outloook.com": "outlook.com",
  "iclould.com": "icloud.com",
  "icloud.co": "icloud.com",
  "rediffmail.co": "rediffmail.com",
  "redifmail.com": "rediffmail.com",
};

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com",
  "10minutemail.com", "10minutemail.net", "temp-mail.org", "tempmail.com",
  "tempmail.dev", "throwawaymail.com", "yopmail.com", "yopmail.fr",
  "getnada.com", "nada.email", "maildrop.cc", "dispostable.com",
  "trashmail.com", "trashmail.de", "mytemp.email", "fakeinbox.com",
  "mail-temp.com", "mohmal.com", "tempinbox.com", "emailondeck.com",
  "spamgourmet.com", "mailnesia.com", "mintemail.com", "burnermail.io",
  "temp-mail.io", "moakt.com", "tmail.ws", "linshiyouxiang.net",
]);

const ROLE_LOCAL_PARTS = new Set([
  "admin", "administrator", "webmaster", "hostmaster", "postmaster",
  "noreply", "no-reply", "donotreply", "do-not-reply",
  "info", "contact", "support", "help", "sales", "billing", "office",
  "abuse", "security", "root", "mailer-daemon", "marketing", "newsletter",
  "team", "hello", "hr", "jobs", "careers",
]);

// Domains so well-known that a DNS lookup is wasted work (and a resolver
// hiccup on them would wrongly mark half the audience risky).
const KNOWN_GOOD_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com",
  "me.com", "aol.com", "protonmail.com", "proton.me", "zoho.com",
  "zohomail.in", "rediffmail.com", "yandex.com", "gmx.com", "fastmail.com",
]);

const SYNTAX_RE = /^[A-Za-z0-9._%+\-']+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}$/;

export function normalizeEmailAddress(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Cheap, synchronous checks only (no network). Returns null when they pass. */
export function staticVerify(rawEmail: unknown): VerifyResult | null {
  const email = normalizeEmailAddress(rawEmail);
  if (!email || email.length > 254 || !SYNTAX_RE.test(email)) {
    return { email, verdict: "invalid", reason: "Not a valid email address" };
  }
  const [local, domain] = email.split("@");
  if (local.length > 64 || email.includes("..")) {
    return { email, verdict: "invalid", reason: "Not a valid email address" };
  }
  const suggestion = COMMON_EMAIL_DOMAIN_TYPOS[domain];
  if (suggestion) {
    return { email, verdict: "invalid", reason: `Misspelled domain — did you mean ${local}@${suggestion}?` };
  }
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { email, verdict: "invalid", reason: `Disposable email provider (${domain})` };
  }
  return null;
}

type DomainCheck = { verdict: EmailVerdict; reason: string };

// One DNS answer per domain per invocation; a 5k-row import shares lookups.
const domainCache = new Map<string, Promise<DomainCheck>>();

async function checkDomainDns(domain: string): Promise<DomainCheck> {
  if (KNOWN_GOOD_DOMAINS.has(domain)) return { verdict: "valid", reason: "Known mail provider" };
  const withTimeout = <T>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  try {
    const mx = await withTimeout(Deno.resolveDns(domain, "MX"), 4000);
    if (Array.isArray(mx) && mx.length > 0) return { verdict: "valid", reason: "Mail server found" };
  } catch (error) {
    if (String(error).includes("NXDOMAIN") || String(error).includes("NotFound")) {
      return { verdict: "invalid", reason: `Domain does not exist (${domain})` };
    }
    // Transient failure — fall through to the A-record check below.
  }
  try {
    const a = await withTimeout(Deno.resolveDns(domain, "A"), 4000);
    if (Array.isArray(a) && a.length > 0) {
      return { verdict: "risky", reason: `No mail server advertised for ${domain}` };
    }
  } catch (error) {
    if (String(error).includes("NXDOMAIN") || String(error).includes("NotFound")) {
      return { verdict: "invalid", reason: `Domain does not exist (${domain})` };
    }
    return { verdict: "risky", reason: "Domain lookup failed (temporary)" };
  }
  return { verdict: "risky", reason: `No mail server advertised for ${domain}` };
}

export function verifyDomain(domain: string): Promise<DomainCheck> {
  let cached = domainCache.get(domain);
  if (!cached) {
    cached = checkDomainDns(domain);
    domainCache.set(domain, cached);
  }
  return cached;
}

/** Full verification: static checks + role-account heuristic + domain DNS. */
export async function verifyEmailAddress(rawEmail: unknown): Promise<VerifyResult> {
  const failed = staticVerify(rawEmail);
  if (failed) return failed;

  const email = normalizeEmailAddress(rawEmail);
  const [local, domain] = email.split("@");

  const dns = await verifyDomain(domain);
  if (dns.verdict !== "valid") return { email, verdict: dns.verdict, reason: dns.reason };

  if (ROLE_LOCAL_PARTS.has(local.replace(/\+.*$/, ""))) {
    return { email, verdict: "risky", reason: `Role account (${local}@) — often unmonitored` };
  }
  return { email, verdict: "valid", reason: dns.reason };
}
