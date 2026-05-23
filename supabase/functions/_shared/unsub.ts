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
