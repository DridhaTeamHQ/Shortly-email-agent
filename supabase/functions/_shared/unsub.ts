// Shared HMAC-SHA256 token helpers for unsubscribe links.

/**
 * Generate an HMAC-SHA256 token for the given email using the provided secret.
 * Returns a lowercase hex string.
 */
export async function generateUnsubToken(
  email: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(email));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify that the token matches the expected HMAC for the email.
 * Uses constant-time comparison to prevent timing attacks.
 */
export async function verifyUnsubToken(
  email: string,
  token: string,
  secret: string,
): Promise<boolean> {
  const expected = await generateUnsubToken(email, secret);
  if (expected.length !== token.length) return false;

  // Constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Secrets a token may have been signed with: the current service-role key,
 * then any retired keys listed (comma-separated) in UNSUB_LEGACY_SECRETS.
 * Links already sitting in inboxes must keep working after a key changes --
 * e.g. the 2026-10-13 welcomes were signed with a key that no longer matches
 * production. Tokens are only ever CREATED with the current key.
 */
export function unsubSecrets(currentKey: string): string[] {
  const legacy = (Deno.env.get("UNSUB_LEGACY_SECRETS") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return [currentKey, ...legacy.filter((s) => s !== currentKey)];
}

/** True when the token matches the HMAC under any of the given secrets. */
export async function verifyUnsubTokenAny(
  email: string,
  token: string,
  secrets: string[],
): Promise<boolean> {
  for (const secret of secrets) {
    if (await verifyUnsubToken(email, token, secret)) return true;
  }
  return false;
}
