import { json } from "../_shared/http.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-agent-token",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS"
};

function readEnv(...names: string[]) {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) {
      return value;
    }
  }

  return "";
}

function timingSafeEqualString(a: string, b: string) {
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return mismatch === 0;
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function createHmacSignature(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function verifySignedToken(token: string, secret: string) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return { ok: false, error: "invalid token" };
  }

  let payload: Record<string, unknown>;
  try {
    const bytes = decodeBase64Url(encodedPayload);
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, error: "invalid token payload" };
  }

  const expectedSignature = await createHmacSignature(encodedPayload, secret);
  if (!timingSafeEqualString(signature, expectedSignature)) {
    return { ok: false, error: "invalid token signature" };
  }

  const expiresAt = Number(payload.expiresAt || 0);
  if (!expiresAt || expiresAt < Date.now()) {
    return { ok: false, error: "token expired" };
  }

  if (payload.type !== "agent-access") {
    return { ok: false, error: "invalid token type" };
  }

  return {
    ok: true,
    payload
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: { token?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const token = body.token?.trim();
  if (!token) {
    return json({ error: "token is required" }, 400);
  }

  const signedSecret = readEnv("SHORTLY_AGENT_AUTH_SECRET", "SHORTLY_AGENT_SHARED_TOKEN");
  if (!signedSecret) {
    return json({ error: "Missing token verification secret." }, 500);
  }

  const signedVerification = await verifySignedToken(token, signedSecret);
  if (signedVerification.ok) {
    return json({
      ok: true,
      app: "shortly-email-agent",
      session: signedVerification.payload
    });
  }

  const legacyToken = readEnv("SHORTLY_AGENT_SHARED_TOKEN");
  if (legacyToken && timingSafeEqualString(token, legacyToken)) {
    return json({ ok: true, app: "shortly-email-agent", legacy: true });
  }

  return json({ error: signedVerification.error || "invalid token" }, 401);
});
