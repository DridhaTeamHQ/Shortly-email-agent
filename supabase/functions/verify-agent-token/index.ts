import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";

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

  const expected = requiredEnv("SHORTLY_AGENT_SHARED_TOKEN").trim();
  if (token !== expected) {
    return json({ error: "invalid token" }, 401);
  }

  return json({ ok: true, app: "shortly-email-agent" });
});
