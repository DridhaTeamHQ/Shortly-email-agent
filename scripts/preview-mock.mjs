// Local MOCK preview (no Supabase) — for testing features that need a DB column
// before it's deployed (e.g. the new Short Article `category` tag). Serves the static
// dashboard, a dynamic /config.js -> /api/*, and in-memory mock data for both
// workspaces. review-article persists status/section/CATEGORY/edits in memory so the
// full QA flow is clickable. No auth token -> auto-unlocks.
//
// Usage: node scripts/preview-mock.mjs   ->   http://localhost:4173

import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number.parseInt(process.env.PORT || "4173", 10);
const now = () => new Date().toISOString();

const ART = (title, topic, source, status, category = null) => ({
  id: randomUUID(), title, edited_title: null,
  url: `https://example.com/${randomUUID().slice(0, 8)}`,
  summary: `${title}. A clean ~300-character preview summary so each Short Article card renders with its source, topic, the new editorial category tag, and status while you test the workspace flow.`,
  edited_summary: null, source, topic, section: "wrapped", category, status,
  rank_score: 0.9, scraped_at: now(), summarized_at: now(),
  reviewed_at: ["approved", "rejected", "sent"].includes(status) ? now() : null,
  reviewed_by: status === "approved" ? "qa" : null, sent_at: null
});
const CASE = (headline, company, status) => ({
  id: randomUUID(), source: "The Ken", source_url: "https://the-ken.com/x", source_title: headline,
  company, headline, case_type: "listed", summary: `${company}: preview case summary.`, detail: `${company}: preview case detail.`,
  status, generated_at: now(), updated_at: now()
});
const DRAFT = (slug, name, format, status) => ({
  id: randomUUID(), topic_slug: slug, topic_name: name, format,
  headline: `${name}: preview issue`, summary: `${name} summary.`, detail: `${name} detail.`,
  status, generated_at: now(), primary_source_url: "https://example.com/s", source_links: [{ source: name, url: "https://example.com/s" }],
  content: format === "hybrid" ? { briefs: [1, 2, 3, 4, 5].map((i) => ({ headline: `${name} brief ${i}`, what_happened: "What happened.", why_it_matters: "Why it matters.", source_url: "https://example.com/s" })), feature: { headline: `${name} feature`, summary: "Feature summary.", detail: "Feature detail.", source_url: "https://example.com/s" } } : {}
});

const store = {
  articles: [
    ART("FERC gives grid operators 60 days on data center power rules", "World", "TOI", "summarized"),
    ART("RBI holds repo rate at 6.5%", "India Business", "ET", "summarized", "Money Matters"),
    ART("SC upholds new data-protection rules under DPDP", "India", "The Hindu", "summarized"),
    ART("DLF launches new Gurgaon phase, 1,200 units", "India Business", "ET", "summarized"),
    ART("Cabinet approves new rail corridor", "India", "TOI", "approved", "Policy Partner"),
    ART("Niche local festival writeup", "India", "TOI", "rejected")
  ],
  corporateCases: [CASE("How Zomato turned profitable", "Zomato", "approved"), CASE("Why a D2C brand shut down", "ExampleCo", "draft")],
  editorialDrafts: [DRAFT("real-estate", "Real Estate", "hybrid", "approved"), DRAFT("money-matters", "Money Matters", "hybrid", "draft"), DRAFT("policy-partner", "Policy Partner", "single", "approved"), DRAFT("wellness-daily", "Wellness Daily", "single", "draft")],
  subscribers: [
    { id: randomUUID(), email: "reader@example.com", full_name: "Reader", phone_number: null, topics: ["daily-wrap"], status: "subscribed", created_at: now() },
    { id: randomUUID(), email: "analyst@example.com", full_name: "Analyst", phone_number: null, topics: ["corporate-case", "money-matters"], status: "subscribed", created_at: now() }
  ],
  digests: []
};

function sendJson(res, body, code = 200) { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { r(d ? JSON.parse(d) : {}); } catch { r({}); } }); }); }

const CONFIG_JS = `// MOCK preview config.
window.SHORTLY = {
  list:"/api/list-articles", review:"/api/review-article", digest:"/api/send-daily-digest",
  curatedDigest:"/api/send-curated-digest", topicDigest:"/api/send-topic-digest", submit:"/api/send-article",
  subscribers:"/api/subscribers", scrape:"/api/scrape-news", summarize:"/api/summarize-articles",
  corporateCase:"/api/corporate-case-agent", editorialTopics:"/api/editorial-topic-agent",
  siteUrl:"", twitterUrl:"https://x.com/Shortly_news", linkedinUrl:"", agentAppUrl:"",
  anonKey:"", dailyCap:10, reviewer:"local-mock"
};`;

const ALLOWED_CATS = ["Corporate Case", "Real Estate", "Policy Partner", "Money Matters", "Wellness Daily"];

async function api(req, res, pathname, url) {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "content-type,authorization,apikey" }); return res.end(); }

  if (pathname === "/api/list-articles" && req.method === "GET") {
    const status = url.searchParams.get("status") || "summarized";
    const arts = status === "all" ? store.articles : store.articles.filter((a) => a.status === status);
    const counts = {}; store.articles.forEach((a) => (counts[a.status] = (counts[a.status] || 0) + 1));
    return sendJson(res, { articles: arts, counts });
  }
  if (pathname === "/api/review-article" && req.method === "POST") {
    const b = await readBody(req);
    const a = store.articles.find((x) => x.id === b.id);
    if (!a) return sendJson(res, { error: "not found" }, 404);
    if (b.action === "approve") { a.status = "approved"; a.reviewed_at = now(); }
    else if (b.action === "reject") { a.status = "rejected"; a.reviewed_at = now(); }
    if (b.section) a.section = b.section;
    if (typeof b.category === "string") a.category = ALLOWED_CATS.includes(b.category.trim()) ? b.category.trim() : null;
    if (b.edited_title) a.edited_title = b.edited_title;
    if (b.edited_summary) a.edited_summary = b.edited_summary;
    return sendJson(res, { article: a });
  }
  if (pathname === "/api/corporate-case-agent") {
    if (req.method === "GET") return sendJson(res, { cases: store.corporateCases });
    const b = await readBody(req); const c = store.corporateCases.find((x) => x.id === b.id);
    if (c) { if (b.action === "approve") c.status = "approved"; else if (b.action === "reject") c.status = "rejected"; else if (b.action === "update") { if (b.headline) c.headline = b.headline; } }
    return sendJson(res, { case: c || null });
  }
  if (pathname === "/api/editorial-topic-agent") {
    if (req.method === "GET") return sendJson(res, { topics: [], drafts: store.editorialDrafts });
    const b = await readBody(req); const d = store.editorialDrafts.find((x) => x.id === b.id);
    if (d) { if (b.action === "approve") d.status = "approved"; else if (b.action === "reject") d.status = "rejected"; else if (b.action === "update") { if (b.headline) d.headline = b.headline; } }
    return sendJson(res, { draft: d || null });
  }
  if (pathname === "/api/subscribers") {
    if (req.method === "GET") return sendJson(res, { subscribers: store.subscribers });
    const b = await readBody(req);
    if (b.action === "add") store.subscribers.push({ id: randomUUID(), email: b.email, full_name: b.full_name || null, phone_number: b.phone_number || null, topics: b.topics || ["daily-wrap"], status: "subscribed", created_at: now() });
    else if (b.action === "update") { const s = store.subscribers.find((x) => x.id === b.id); if (s && b.status) s.status = b.status; }
    else if (b.action === "delete") store.subscribers = store.subscribers.filter((x) => x.id !== b.id);
    return sendJson(res, { ok: true });
  }
  if (["/api/send-daily-digest", "/api/send-curated-digest", "/api/send-topic-digest", "/api/scrape-news", "/api/summarize-articles", "/api/send-article"].includes(pathname) && req.method === "POST")
    return sendJson(res, { mock: true, sent: store.subscribers.length, failed: 0 });
  return sendJson(res, { error: "not found" }, 404);
}

const types = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const pathname = url.pathname;
  if (pathname.startsWith("/api/")) { try { await api(req, res, pathname, url); } catch (e) { sendJson(res, { error: String(e) }, 500); } return; }
  if (pathname === "/config.js") { res.writeHead(200, { "Content-Type": types[".js"] }); return res.end(CONFIG_JS); }
  const filePath = normalize(join(ROOT, decodeURIComponent(pathname === "/" ? "/index.html" : pathname)));
  if (!filePath.startsWith(ROOT) || !existsSync(filePath)) { res.writeHead(404); return res.end("Not found"); }
  const info = await stat(filePath);
  if (!info.isFile()) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": types[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}).listen(PORT, () => {
  console.log(`Shortly MOCK preview (category demo): http://localhost:${PORT}`);
  console.log(`  Short Articles: ${store.articles.length} (2 pre-tagged) | review-article persists category in-memory.`);
});
