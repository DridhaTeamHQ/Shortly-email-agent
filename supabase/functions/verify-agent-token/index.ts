const AUTH_VERSION = "2026-07-20-hmac-encodings";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-agent-token",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS"
};

function authJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "x-shortly-auth-version": AUTH_VERSION
    }
  });
}

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

async function createHmacSignatures(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const bytes = new Uint8Array(signature);
  const base64 = btoa(String.fromCharCode(...bytes));
  const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [base64url, base64, hex];
}

async function matchesHmacSignature(signature: string, payload: string, secret: string) {
  const expectedSignatures = await createHmacSignatures(payload, secret);
  return expectedSignatures.some((expected) => timingSafeEqualString(signature, expected));
}

function hasValidExpiry(payload: Record<string, unknown>) {
  const expiresAt = Number(payload.expiresAt || 0);
  const exp = Number(payload.exp || 0);
  if (expiresAt) return expiresAt > Date.now();
  if (exp) return exp * 1000 > Date.now();
  return false;
}

function hasValidAgentType(payload: Record<string, unknown>) {
  if (!payload.type) return true;
  return payload.type === "agent-access" || payload.type === "shortly-agent-token";
}

async function verifyPayloadToken(token: string, secret: string) {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { ok: false, error: "invalid token" };
  }

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) {
    return { ok: false, error: "invalid token" };
  }

  let payload: Record<string, unknown>;
  let payloadText = "";
  try {
    const bytes = decodeBase64Url(encodedPayload);
    payloadText = new TextDecoder().decode(bytes);
    payload = JSON.parse(payloadText);
  } catch {
    return { ok: false, error: "invalid token payload" };
  }

  if (
    !(await matchesHmacSignature(signature, encodedPayload, secret)) &&
    !(await matchesHmacSignature(signature, payloadText, secret))
  ) {
    return { ok: false, error: "invalid token signature" };
  }

  if (!hasValidExpiry(payload)) {
    return { ok: false, error: "token expired" };
  }

  if (!hasValidAgentType(payload)) {
    return { ok: false, error: "invalid token type" };
  }

  return {
    ok: true,
    payload
  };
}

async function verifyJwtToken(token: string, secret: string) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, error: "invalid token" };
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  if (!encodedHeader || !encodedPayload || !signature) {
    return { ok: false, error: "invalid token" };
  }

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedHeader)));
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload)));
  } catch {
    return { ok: false, error: "invalid token payload" };
  }

  if (header.alg && header.alg !== "HS256") {
    return { ok: false, error: "unsupported token algorithm" };
  }

  if (!(await matchesHmacSignature(signature, `${encodedHeader}.${encodedPayload}`, secret))) {
    return { ok: false, error: "invalid token signature" };
  }

  if (!hasValidExpiry(payload)) {
    return { ok: false, error: "token expired" };
  }

  if (!hasValidAgentType(payload)) {
    return { ok: false, error: "invalid token type" };
  }

  return {
    ok: true,
    payload
  };
}

async function verifySignedToken(token: string, secret: string) {
  const jwtVerification = await verifyJwtToken(token, secret);
  if (jwtVerification.ok || token.split(".").length === 3) {
    return jwtVerification;
  }
  return await verifyPayloadToken(token, secret);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return authJson({ error: "Method not allowed" }, 405);
  }

  let body: { token?: string };
  try {
    body = await request.json();
  } catch {
    return authJson({ error: "invalid JSON" }, 400);
  }

  const token = body.token?.trim();
  if (!token) {
    return authJson({ error: "token is required" }, 400);
  }

  const signedSecret = readEnv("SHORTLY_AGENT_AUTH_SECRET", "SHORTLY_AGENT_SHARED_TOKEN");
  if (!signedSecret) {
    return authJson({ error: "Missing token verification secret." }, 500);
  }

  const signedVerification = await verifySignedToken(token, signedSecret);
  if (signedVerification.ok) {
    return authJson({
      ok: true,
      app: "shortly-email-agent",
      session: signedVerification.payload
    });
  }

  const legacyToken = readEnv("SHORTLY_AGENT_SHARED_TOKEN");
  if (legacyToken && timingSafeEqualString(token, legacyToken)) {
    return authJson({ ok: true, app: "shortly-email-agent", legacy: true });
  }

  return authJson({
    error: signedVerification.error || "invalid token",
    authVersion: AUTH_VERSION
  }, 401);
});
