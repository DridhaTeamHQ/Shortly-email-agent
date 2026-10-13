// Run edge functions from THIS checkout on localhost, against the live
// Supabase database, so new code can be tried before it is deployed.
//
//   npx --yes deno run -A --node-modules-dir=none scripts/local-functions.ts
//   -> http://localhost:8787/functions/v1/<name>   (same paths as Supabase)
//
// Reads .env. Sending email needs AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
// AWS_REGION in .env (Supabase keeps its copies as write-only secrets); without
// them every send fails safely instead of going anywhere. Production values the
// local .env does not carry are set below.

const ROOT = new URL("..", import.meta.url);
const PORT = Number(Deno.env.get("LOCAL_FUNCTIONS_PORT") ?? 8787);
const FUNCTIONS = ["subscribers", "send-welcomes", "never-send-report", "stats-report"];

for (const line of (await Deno.readTextFile(new URL(".env", ROOT))).split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !Deno.env.get(m[1])) Deno.env.set(m[1], m[2].replace(/^(["'])(.*)\1$/, "$2"));
}
// Mirror production settings (the .env copies of these are stale placeholders).
Deno.env.set("FROM_EMAIL", "Dailywrap <team@dailymattr.com>");
Deno.env.set("SES_CONFIGURATION_SET", "dailymattr-events");
Deno.env.set("ONE_CLICK_UNSUB", "1");
// REPORT_EMAIL_TO and ALLOWED_EMAIL_ADDRESSES come from .env (personal
// addresses are kept out of git); without them reports are not sent locally.
// The real secret has no Brevo key locally; make sure a failed SES send can
// never silently fall back to an unauthenticated provider.
Deno.env.delete("SMTP_PASS");

const hasAws = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"].every((k) => Deno.env.get(k));

// Each function calls Deno.serve() when imported; capture its handler instead.
type Handler = (request: Request) => Response | Promise<Response>;
const handlers = new Map<string, Handler>();
const realServe = Deno.serve.bind(Deno);
let registering = "";
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (a: any, b?: any) => {
  handlers.set(registering, typeof a === "function" ? a : b ?? a.handler);
  return { finished: new Promise(() => {}), shutdown: async () => {}, ref() {}, unref() {}, addr: { hostname: "local", port: 0 } };
};
for (const name of FUNCTIONS) {
  registering = name;
  await import(new URL(`supabase/functions/${name}/index.ts`, ROOT).href);
}

realServe({ port: PORT }, async (request) => {
  const name = new URL(request.url).pathname.replace(/^\/functions\/v1\//, "").replace(/^\//, "");
  const handler = handlers.get(name);
  if (!handler) return new Response(`Unknown function "${name}". Local: ${FUNCTIONS.join(", ")}`, { status: 404 });
  const started = Date.now();
  const response = await handler(request);
  console.log(`${new Date().toISOString()} ${request.method} ${name} -> ${response.status} (${Date.now() - started} ms)`);
  return response;
});
console.log(`Local functions on http://localhost:${PORT}/functions/v1/{${FUNCTIONS.join(",")}}`);
console.log(hasAws ? "SES keys found: sends are REAL." : "No AWS keys in .env: sends will fail safely (nothing is emailed).");
