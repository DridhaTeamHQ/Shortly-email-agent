// Server-side auth for dashboard/pipeline edge functions. The Supabase gateway
// (verify_jwt) only proves the caller holds SOME valid JWT — and the anon key
// is public (it ships in the site + dashboard bundles). Before this guard, any
// visitor could invoke the QA mutations, the email sends, and the OpenAI
// spenders. A request is authorized when it carries EITHER:
//   1. a service_role JWT   — pg_cron via invoke_edge (Vault key), server jobs
//   2. x-agent-token header — the QA dashboard's login token, verified exactly
//      like verify-agent-token does: HMAC-signed session token (against
//      SHORTLY_AGENT_AUTH_SECRET, falling back to SHORTLY_AGENT_SHARED_TOKEN
//      as the signing key) or the legacy shared token by equality.
import { json } from "./http.ts";

function readEnv(...names: string[]): string {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return "";
}

// The gateway already validated the JWT's signature; we only read its role.
function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized));
    return typeof decoded.role === "string" ? decoded.role : null;
  } catch {
    return null;
  }
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmacSignatures(payload: string, secret: string): Promise<string[]> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const bytes = new Uint8Array(signature);
  const base64 = btoa(String.fromCharCode(...bytes));
  const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [base64url, base64, hex];
}

async function matchesHmacSignature(signature: string, payload: string, secret: string): Promise<boolean> {
  const expectedSignatures = await hmacSignatures(payload, secret);
  return expectedSignatures.some((expected) => timingSafeEqualString(signature, expected));
}

function hasValidExpiry(payload: Record<string, unknown>): boolean {
  const expiresAt = Number(payload.expiresAt || 0);
  const exp = Number(payload.exp || 0);
  if (expiresAt) return expiresAt > Date.now();
  if (exp) return exp * 1000 > Date.now();
  return false;
}

function hasValidAgentType(payload: Record<string, unknown>): boolean {
  if (!payload.type) return true;
  return payload.type === "agent-access" || payload.type === "shortly-agent-token";
}

async function isValidAgentToken(token: string): Promise<boolean> {
  if (!token) return false;
  const signedSecret = readEnv("SHORTLY_AGENT_AUTH_SECRET", "SHORTLY_AGENT_SHARED_TOKEN");
  const parts = token.split(".");

  // HS256 JWT session token: <base64url header>.<base64url payload>.<hmac>
  if (signedSecret && parts.length === 3) {
    const [encodedHeader, encodedPayload, signature] = parts;
    try {
      const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedHeader)));
      const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload)));
      if (
        (!header.alg || header.alg === "HS256") &&
        (await matchesHmacSignature(signature, `${encodedHeader}.${encodedPayload}`, signedSecret)) &&
        hasValidExpiry(payload) &&
        hasValidAgentType(payload)
      ) {
        return true;
      }
    } catch {
      // fall through to legacy comparison
    }
  }

  // Signed session token: <base64url payload>.<hmac>
  if (signedSecret && parts.length === 2) {
    const [encodedPayload, signature] = parts;
    try {
      const payloadText = new TextDecoder().decode(decodeBase64Url(encodedPayload));
      const payload = JSON.parse(payloadText);
      if (
        ((await matchesHmacSignature(signature, encodedPayload, signedSecret)) ||
          (await matchesHmacSignature(signature, payloadText, signedSecret))) &&
        hasValidExpiry(payload) &&
        hasValidAgentType(payload)
      ) {
        return true;
      }
    } catch {
      // fall through to legacy comparison
    }
  }
  const legacy = readEnv("SHORTLY_AGENT_SHARED_TOKEN");
  return Boolean(legacy) && timingSafeEqualString(token, legacy);
}

export async function isAuthorizedAgent(request: Request): Promise<boolean> {
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (jwtRole(bearer) === "service_role") return true;
  const agentToken = (request.headers.get("x-agent-token") ?? "").trim();
  const clientInfoToken = (request.headers.get("x-client-info") ?? "")
    .trim()
    .match(/(?:^|[,\s])shortly-agent-token\s+(.+)$/i)?.[1]
    ?.trim() ?? "";
  return await isValidAgentToken(agentToken || clientInfoToken);
}

// Drop-in gate: `const denied = await requireAgent(request); if (denied) return denied;`
export async function requireAgent(request: Request): Promise<Response | null> {
  if (await isAuthorizedAgent(request)) return null;
  return json({ error: "forbidden: agent credentials required" }, 403);
}
