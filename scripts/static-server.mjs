// Dev server: static files + in-memory API that mocks the Supabase edge functions.
// Routes:
//   POST /api/submit-article         — scraper handoff (one article); summarizes with GPT-4o
//   POST /api/summarize-articles     — batch-summarize anything still pending (manual trigger)
//   GET  /api/list-articles?status=
//   POST /api/review-article         — approve/reject/edit (enforces daily cap)
//   POST /api/send-daily-digest      — sends exactly DAILY_CAP approved as one email (MOCK)
//   GET  /api/subscribers            — list
//   POST /api/subscribers            — { action: add|update|delete, ... }

import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PORT = Number.parseInt(process.env.PORT || "4173", 10);
const DATA_DIR = resolve(ROOT, ".devdata");
const DB_PATH = join(DATA_DIR, "store.json");
const DAILY_CAP = Number.parseInt(process.env.DAILY_CAP || "10", 10);

// ---------- env ----------
function loadEnv() {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

// ---------- JSON store ----------
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
function readDb() {
  if (!existsSync(DB_PATH)) return { articles: [], subscribers: [] };
  try {
    const d = JSON.parse(readFileSync(DB_PATH, "utf8"));
    d.articles ??= [];
    d.subscribers ??= [];
    return d;
  } catch {
    return { articles: [], subscribers: [] };
  }
}
function writeDb(db) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---------- OpenAI summarize ----------
const SYSTEM_PROMPT = `You are a senior editor for a respected daily news briefing read by busy professionals.

Write EXACTLY 2 sentences. 45-60 words total. Active voice.

Sentence 1: Lead with the news — who did what, with key numbers, dates, and named entities.
Sentence 2: The immediate consequence, reaction, or "why it matters" — concrete, not abstract.

STRICT RULES:
- Active voice always. ("Apple unveiled..." not "Apple's plan was unveiled...")
- No filler: avoid "the legislation aims to", "according to officials", "in a statement", "it was reported that".
- No hedging: cut "could", "may", "appears to" unless central to the story.
- No editorializing, no opinions, no marketing language, no emoji, no quotes.
- Preserve specific numbers, percentages, dates, currencies, and proper names.

Return ONLY the summary text. Plain prose. No markdown, no preface, no labels.`;

async function summarize(article) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing in .env");
  const user = [
    `TITLE: ${article.title}`,
    article.source ? `SOURCE: ${article.source}` : null,
    `URL: ${article.url}`,
    article.raw_content ? `EXCERPT:\n${article.raw_content}` : null
  ]
    .filter(Boolean)
    .join("\n\n");

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 180,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user }
      ]
    })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = await r.json();
  return body?.choices?.[0]?.message?.content?.trim();
}

// ---------- helpers ----------
const todayUtc = () => new Date().toISOString().slice(0, 10);
const isApprovedToday = (a) =>
  a.status === "approved" && (a.reviewed_at ?? "").slice(0, 10) === todayUtc();

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}
function json(res, body, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(body));
}

// ---------- routes ----------
async function handleApi(req, res, pathname, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, authorization"
    });
    return res.end();
  }

  // POST /api/submit-article  { title, url, source?, topic?, raw_content? }
  if (pathname === "/api/submit-article" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.title?.trim() || !body.url?.trim()) {
      return json(res, { error: "title and url required" }, 400);
    }
    const db = readDb();
    if (db.articles.some((a) => a.url === body.url)) {
      return json(res, { error: "duplicate url" }, 409);
    }
    const article = {
      id: randomUUID(),
      title: body.title.trim().slice(0, 500),
      url: body.url.trim(),
      raw_content: (body.raw_content || "").slice(0, 4000),
      summary: null,
      edited_summary: null,
      source: body.source?.trim() || null,
      topic: body.topic?.trim() || null,
      status: "summarized",
      rank_score: 1,
      scraped_at: new Date().toISOString(),
      summarized_at: null,
      reviewed_at: null,
      reviewed_by: null,
      sent_at: null
    };
    try {
      const s = await summarize(article);
      article.summary = s;
      article.summarized_at = new Date().toISOString();
    } catch (e) {
      return json(res, { error: `summarize failed: ${String(e).slice(0, 200)}` }, 502);
    }
    db.articles.push(article);
    writeDb(db);
    return json(res, { article });
  }

  // POST /api/summarize-articles — sweep any still-pending articles
  if (pathname === "/api/summarize-articles" && req.method === "POST") {
    const db = readDb();
    const pending = db.articles.filter((a) => a.status === "pending");
    let ok = 0;
    for (const a of pending) {
      try {
        a.summary = await summarize(a);
        a.status = "summarized";
        a.summarized_at = new Date().toISOString();
        ok++;
      } catch {}
    }
    writeDb(db);
    return json(res, { summarized: ok });
  }

  // GET /api/list-articles?status=summarized|approved|rejected|sent|all
  if (pathname === "/api/list-articles" && req.method === "GET") {
    const status = url.searchParams.get("status") || "summarized";
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10), 500);
    const db = readDb();
    const sorted = db.articles
      .slice()
      .sort((a, b) => new Date(b.scraped_at) - new Date(a.scraped_at));
    const filtered = status === "all" ? sorted : sorted.filter((a) => a.status === status);
    const counts = {};
    for (const a of db.articles) counts[a.status] = (counts[a.status] || 0) + 1;
    return json(res, { articles: filtered.slice(0, limit), counts, daily_cap: DAILY_CAP });
  }

  // POST /api/review-article { id, action, edited_summary?, reviewer? }
  if (pathname === "/api/review-article" && req.method === "POST") {
    const body = await readBody(req);
    const { id, action, edited_summary, reviewer } = body;
    if (!id || !action) return json(res, { error: "id and action required" }, 400);
    const db = readDb();
    const a = db.articles.find((x) => x.id === id);
    if (!a) return json(res, { error: "not found" }, 404);

    if (action === "approve") {
      const wasApprovedToday = isApprovedToday(a);
      const usedToday = db.articles.filter(isApprovedToday).length - (wasApprovedToday ? 1 : 0);
      if (usedToday >= DAILY_CAP) {
        return json(res, { error: `Daily cap of ${DAILY_CAP} reached` }, 409);
      }
      a.status = "approved";
      if (edited_summary?.trim()) a.edited_summary = edited_summary.trim();
    } else if (action === "reject") {
      a.status = "rejected";
    } else if (action === "edit") {
      if (!edited_summary?.trim()) return json(res, { error: "edited_summary required" }, 400);
      a.edited_summary = edited_summary.trim();
    } else {
      return json(res, { error: "bad action" }, 400);
    }
    a.reviewed_at = new Date().toISOString();
    a.reviewed_by = reviewer || null;
    writeDb(db);
    return json(res, { article: a });
  }

  // GET /api/subscribers
  if (pathname === "/api/subscribers" && req.method === "GET") {
    const db = readDb();
    return json(res, { subscribers: db.subscribers });
  }

  // POST /api/subscribers  { action: add|update|delete, ... }
  if (pathname === "/api/subscribers" && req.method === "POST") {
    const body = await readBody(req);
    const db = readDb();
    if (body.action === "add") {
      const email = (body.email || "").trim().toLowerCase();
      if (!email || !email.includes("@")) return json(res, { error: "valid email required" }, 400);
      if (db.subscribers.some((s) => s.email === email)) return json(res, { error: "already exists" }, 409);
      const sub = {
        id: randomUUID(),
        email,
        full_name: (body.full_name || "").trim() || null,
        status: "subscribed",
        created_at: new Date().toISOString()
      };
      db.subscribers.push(sub);
      writeDb(db);
      return json(res, { subscriber: sub });
    }
    if (body.action === "update") {
      const s = db.subscribers.find((x) => x.id === body.id);
      if (!s) return json(res, { error: "not found" }, 404);
      if (body.status) s.status = body.status;
      if (body.full_name !== undefined) s.full_name = body.full_name || null;
      writeDb(db);
      return json(res, { subscriber: s });
    }
    if (body.action === "delete") {
      const before = db.subscribers.length;
      db.subscribers = db.subscribers.filter((x) => x.id !== body.id);
      writeDb(db);
      return json(res, { deleted: before - db.subscribers.length });
    }
    return json(res, { error: "bad action" }, 400);
  }

  // POST /api/send-daily-digest — MOCK: writes preview HTML, marks articles sent
  if (pathname === "/api/send-daily-digest" && req.method === "POST") {
    const db = readDb();
    const top = db.articles.filter(isApprovedToday).slice(0, DAILY_CAP);
    if (top.length < DAILY_CAP) {
      return json(res, { error: `Need ${DAILY_CAP} approved (have ${top.length})` }, 400);
    }
    const subs = db.subscribers.filter((s) => s.status === "subscribed");
    if (subs.length === 0) return json(res, { error: "No subscribers" }, 400);

    const html = renderDigest(top);
    const file = join(DATA_DIR, `digest-${Date.now()}.html`);
    writeFileSync(file, html);

    top.forEach((a) => {
      a.status = "sent";
      a.sent_at = new Date().toISOString();
    });
    writeDb(db);
    console.log(`[digest] mock-sent to ${subs.length} subscribers — preview: ${file}`);
    return json(res, {
      mock: true,
      articles: top.length,
      recipients: subs.length,
      sent: subs.length,
      preview_file: file
    });
  }

  return json(res, { error: "not found" }, 404);
}

function esc(v = "") {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function renderDigest(articles) {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const items = articles
    .map((a, i) => {
      const text = (a.edited_summary || a.summary || "").trim();
      const meta = [a.source, a.topic].filter(Boolean).map((s) => esc(s)).join(" · ");
      return `<tr><td style="padding:24px 0;border-bottom:1px solid #e6ecf2">
        <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#2acfcf;font-weight:700;margin-bottom:6px">
          ${String(i + 1).padStart(2, "0")} · ${meta || "Top story"}
        </div>
        <h2 style="font-size:20px;line-height:1.3;margin:0 0 10px;color:#242a45">
          <a href="${esc(a.url)}" style="color:#242a45;text-decoration:none">${esc(a.title)}</a>
        </h2>
        <p style="font-size:15px;line-height:1.65;color:#4b5066;margin:0 0 12px">${esc(text)}</p>
        <a href="${esc(a.url)}" style="font-size:14px;color:#1fa4ad;font-weight:600;text-decoration:none">Read full story →</a>
      </td></tr>`;
    })
    .join("");

  return `<!doctype html><html><body style="margin:0;background:#f3f7fb;padding:32px 16px;font-family:Inter,Arial,sans-serif;color:#242a45">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #dce7ef">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
      <strong style="font-size:18px">Shortly Digest</strong>
      <span style="font-size:13px;color:#6a7188">${esc(today)}</span>
    </div>
    <p style="margin:0 0 8px">Hi there,</p>
    <p style="margin:0 0 4px;color:#6a7188;font-size:14px;line-height:1.6">Your ${articles.length}-story briefing of today's most important news.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${items}</table>
  </div></body></html>`;
}

// ---------- static + server ----------
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith("/api/")) {
    try { await handleApi(req, res, pathname, url); }
    catch (e) { json(res, { error: String(e) }, 500); }
    return;
  }

  const filePath = normalize(join(ROOT, decodeURIComponent(pathname === "/" ? "/index.html" : pathname)));
  if (!filePath.startsWith(ROOT) || !existsSync(filePath)) {
    res.writeHead(404); res.end("Not found"); return;
  }
  const info = await stat(filePath);
  if (!info.isFile()) { res.writeHead(404); res.end("Not found"); return; }
  res.writeHead(200, { "Content-Type": types[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}).listen(PORT, () => {
  console.log(`Shortly dev: http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}  |  daily cap: ${DAILY_CAP}  |  OpenAI key: ${Boolean(OPENAI_API_KEY)}`);
});
