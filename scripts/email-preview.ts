// Local email preview -- renders the welcome mail from the edge-function source
// on disk, so a template change can be reviewed before it is deployed.
//
// It sends nothing. It imports the same modules the `subscribers` function
// uses (welcome-email.ts, plain-text.ts), so what you see here is what the
// next deploy will send.
//
// Usage (no Deno install needed):
//   npx --yes deno run -A scripts/email-preview.ts   ->   http://localhost:4180

const ROOT = new URL("..", import.meta.url);
const PORT = Number(Deno.env.get("PORT") ?? 4180);

// The live sender is the FROM_EMAIL Supabase secret; .env's copy is a stale
// placeholder, so the preview shows the production value instead.
const FROM = Deno.env.get("PREVIEW_FROM_EMAIL") ?? "Dailywrap <team@dailymattr.com>";

for (const line of (await Deno.readTextFile(new URL(".env", ROOT))).split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !Deno.env.get(m[1])) Deno.env.set(m[1], m[2].replace(/^(["'])(.*)\1$/, "$2"));
}

const { renderWelcomeEmail, WELCOME_SUBJECT } = await import(
  new URL("supabase/functions/_shared/welcome-email.ts", ROOT).href
);
const { htmlToText } = await import(new URL("supabase/functions/_shared/plain-text.ts", ROOT).href);

const SENDING_DOMAIN = "dailymattr.com";

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// Every host the mail links to or loads from; off-domain hosts are flagged.
function hostsIn(html: string) {
  const hosts = new Map<string, string[]>();
  for (const [, attr, url] of html.matchAll(/\b(href|src)="(https?:\/\/[^"]+)"/gi)) {
    const host = new URL(url.replaceAll("&amp;", "&")).hostname;
    hosts.set(host, [...(hosts.get(host) ?? []), attr.toLowerCase() === "src" ? "image" : "link"]);
  }
  return [...hosts].map(([host, kinds]) => ({
    host,
    kinds: [...new Set(kinds)].join(", "),
    count: kinds.length,
    own: host === SENDING_DOMAIN || host.endsWith(`.${SENDING_DOMAIN}`),
  }));
}

async function render(params: URLSearchParams) {
  const email = (params.get("email") || "reader@example.com").trim().toLowerCase();
  const name = params.get("name")?.trim() || null;
  const html = await renderWelcomeEmail(email, name);
  return { email, name, html, text: htmlToText(html) };
}

function page(r: Awaited<ReturnType<typeof render>>) {
  const q = new URLSearchParams({ email: r.email, ...(r.name ? { name: r.name } : {}) });
  const rows = hostsIn(r.html).map((h) =>
    `<tr><td>${h.own ? "ok" : "<b>off-domain</b>"}</td><td>${escapeHtml(h.host)}</td><td>${h.kinds}</td><td>${h.count}</td></tr>`
  ).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome mail preview</title>
<style>
  body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#191919;background:#f4f4f1}
  main{max-width:1100px;margin:0 auto;padding:20px 16px}
  h1{font-size:18px;margin:0 0 12px} h2{font-size:14px;margin:20px 0 8px;text-transform:uppercase;letter-spacing:.04em;color:#555}
  form{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px} input{padding:6px 8px;border:1px solid #ccc;border-radius:4px}
  button{padding:6px 12px;border:0;border-radius:4px;background:#3979ff;color:#fff;cursor:pointer}
  dl{display:grid;grid-template-columns:90px 1fr;gap:4px 12px;margin:0;background:#fff;border:1px solid #ddd;padding:12px}
  dt{color:#777} dd{margin:0;word-break:break-word}
  table{border-collapse:collapse;background:#fff;width:100%} td{border:1px solid #ddd;padding:4px 8px}
  .cols{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:16px}
  iframe{width:100%;height:900px;border:1px solid #ddd;background:#fff}
  pre{white-space:pre-wrap;background:#fff;border:1px solid #ddd;padding:12px;margin:0;max-height:900px;overflow:auto}
  @media (max-width:800px){.cols{grid-template-columns:1fr}}
</style></head><body><main>
<h1>Welcome mail preview (local, nothing is sent)</h1>
<form><input name="name" placeholder="Name" value="${escapeHtml(r.name ?? "")}">
<input name="email" placeholder="Email" value="${escapeHtml(r.email)}" size="30"><button>Render</button></form>
<dl><dt>From</dt><dd>${escapeHtml(FROM)}</dd><dt>To</dt><dd>${escapeHtml(r.email)}</dd>
<dt>Subject</dt><dd>${escapeHtml(WELCOME_SUBJECT)}</dd>
<dt>Parts</dt><dd>text/html (${r.html.length.toLocaleString()} chars) + text/plain (${r.text.length.toLocaleString()} chars)</dd>
<dt>Headers</dt><dd>No List-Unsubscribe (welcome is sent with bulk: false)</dd></dl>
<h2>Hosts in links and images</h2>
<table><tr><td></td><td>Host</td><td>Used for</td><td>Count</td></tr>${rows}</table>
<div class="cols"><div><h2>HTML</h2><iframe title="HTML part" src="/welcome.html?${q}"></iframe></div>
<div><h2>Plain text</h2><pre>${escapeHtml(r.text)}</pre></div></div>
</main></body></html>`;
}

Deno.serve({ port: PORT }, async (request) => {
  const url = new URL(request.url);
  try {
    const r = await render(url.searchParams);
    if (url.pathname === "/welcome.html") return new Response(r.html, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/welcome.txt") return new Response(r.text, { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (url.pathname === "/") return new Response(page(r), { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("Not found", { status: 404 });
  } catch (error) {
    console.error(error);
    return new Response(`Render failed: ${error instanceof Error ? error.message : error}`, { status: 500 });
  }
});
