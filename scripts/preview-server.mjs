// Local PREVIEW server — lets you see the dashboard (incl. the new AI score badges
// + auto-sort) without Supabase. Serves static files, a dynamic /config.js pointing
// at local mock endpoints, and an in-memory mock API seeded with scored sample data.
//
// Does NOT touch the committed static-server.mjs (prod) or any real backend.
// Usage: node scripts/preview-server.mjs   ->   http://localhost:4173

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number.parseInt(process.env.PORT || "4173", 10);
const today = () => new Date().toISOString();

// ---------- seed data ----------
const SOURCES = ["TOI", "ET", "The Hindu", "Shortly"];
const TOPICS = ["India", "India Business", "World", "Business"];

function neighbors(score) {
  const mk = (t, status, sim) => ({ title: t, status, similarity: sim });
  return score >= 66
    ? [mk("India clears infra bill", "approved", 0.89), mk("RBI holds repo rate", "approved", 0.84), mk("Sensex hits record", "approved", 0.8)]
    : score >= 33
    ? [mk("Monsoon update for week", "approved", 0.71), mk("US politics roundup", "rejected", 0.66), mk("State poll dates", "approved", 0.6)]
    : [mk("Celebrity gossip column", "rejected", 0.78), mk("Foreign local crime", "rejected", 0.72), mk("Sports transfer rumor", "rejected", 0.64)];
}

function makeArticle(e, idx) {
  const status = e.status || "summarized";
  return {
    id: randomUUID(),
    title: e.title,
    edited_title: null,
    url: e.url || `https://example.com/${idx}`,
    summary: e.summary || e.title,            // REAL GPT-4o summary from preview-data.json
    edited_summary: null,
    source: e.source,
    topic: e.topic,
    section: e.section || "wrapped",
    status,
    rank_score: (e.score ?? 50) / 100,
    suggestion_score: e.score ?? 50,
    suggestion_meta: { neighbors: neighbors(e.score ?? 50), k: 8, version: 1 },
    scraped_at: today(),
    summarized_at: today(),
    reviewed_at: status === "approved" || status === "rejected" ? today() : null,
    reviewed_by: status === "approved" || status === "rejected" ? "local" : null,
    sent_at: null
  };
}

const store = { articles: [], subscribers: [] };
const DATA_PATH = resolve(ROOT, "scripts/preview-data.json");
if (existsSync(DATA_PATH)) {
  JSON.parse(readFileSync(DATA_PATH, "utf8")).forEach((e, i) => store.articles.push(makeArticle(e, i)));
} else {
  console.warn("scripts/preview-data.json not found — run: node scripts/gen-preview-data.mjs");
}
store.subscribers.push({ id: randomUUID(), email: "reader@example.com", full_name: "Test Reader", status: "subscribed", created_at: today() });
store.subscribers.push({ id: randomUUID(), email: "editor@shortly.in", full_name: "Editor", status: "subscribed", created_at: today() });

// ---------- helpers ----------
const isApprovedToday = (a) => a.status === "approved";
function send(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((r) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { r(d ? JSON.parse(d) : {}); } catch { r({}); } });
  });
}

const CONFIG_JS = `// LOCAL PREVIEW config — mock endpoints, no real backend.
window.SHORTLY = {
  list: "/api/list-articles",
  review: "/api/review-article",
  digest: "/api/send-daily-digest",
  submit: "/api/send-article",
  subscribers: "/api/subscribers",
  scrape: "/api/scrape-news",
  summarize: "/api/summarize-articles",
  aiInsights: "/api/ai-insights",
  siteUrl: "",
  twitterUrl: "https://x.com/Shortly_news",
  linkedinUrl: "https://www.linkedin.com/company/shortly-news/",
  agentAppUrl: "",
  anonKey: "",
  dailyCap: 10,
  reviewer: "local-preview"
};
`;

// ---------- API ----------
async function api(req, res, pathname, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "content-type,authorization,apikey" });
    return res.end();
  }

  if (pathname === "/api/list-articles" && req.method === "GET") {
    const status = url.searchParams.get("status") || "summarized";
    const arts = status === "all" ? store.articles : store.articles.filter((a) => a.status === status);
    const counts = {};
    store.articles.forEach((a) => (counts[a.status] = (counts[a.status] || 0) + 1));
    return send(res, { articles: arts, counts, daily_cap: 10 });
  }

  if (pathname === "/api/subscribers" && req.method === "GET") return send(res, { subscribers: store.subscribers });

  if (pathname === "/api/subscribers" && req.method === "POST") {
    const b = await readBody(req);
    if (b.action === "add") {
      store.subscribers.push({ id: randomUUID(), email: b.email, full_name: b.full_name || null, status: "subscribed", created_at: today() });
    } else if (b.action === "update") {
      const s = store.subscribers.find((x) => x.id === b.id); if (s && b.status) s.status = b.status;
    } else if (b.action === "delete") {
      store.subscribers = store.subscribers.filter((x) => x.id !== b.id);
    }
    return send(res, { ok: true });
  }

  if (pathname === "/api/review-article" && req.method === "POST") {
    const b = await readBody(req);
    const a = store.articles.find((x) => x.id === b.id);
    if (!a) return send(res, { error: "not found" }, 404);
    if (b.action === "approve") { a.status = "approved"; a.reviewed_at = today(); }
    else if (b.action === "reject") { a.status = "rejected"; a.reviewed_at = today(); }
    else if (b.action === "edit") { if (b.edited_title) a.edited_title = b.edited_title; if (b.edited_summary) a.edited_summary = b.edited_summary; }
    if (b.section) a.section = b.section;
    if (typeof b.rank_score === "number") a.rank_score = b.rank_score;
    return send(res, { article: a });
  }

  if (pathname === "/api/send-daily-digest" && req.method === "POST") {
    const approved = store.articles.filter(isApprovedToday);
    approved.forEach((a) => { a.status = "sent"; a.sent_at = today(); });
    return send(res, { wrapped: approved.length, recipients: store.subscribers.filter((s) => s.status === "subscribed").length, sent: store.subscribers.length, failed: 0, mock: true });
  }

  if ((pathname === "/api/scrape-news" || pathname === "/api/summarize-articles") && req.method === "POST")
    return send(res, { mock: true, summarized: 0, scraped: 0, message: "preview mock" });

  if (pathname === "/api/ai-insights") {
    if (req.method === "POST") {
      const b = await readBody(req);
      if (b.action === "save_config") {
        store.aiConfig = { guidance: b.guidance || "", category_prefs: b.category_prefs || {} };
        return send(res, { ok: true, saved: ["EDITORIAL_GUIDANCE", "CATEGORY_PREFS"] });
      }
      return send(res, { error: "unknown action" }, 400);
    }
    // GET — compute from the in-memory store
    const arts = store.articles;
    const reviewed = arts.filter((a) => ["approved", "sent", "rejected"].includes(a.status));
    const isAppr = (a) => a.status === "approved" || a.status === "sent";
    const byTopic = {};
    reviewed.forEach((a) => {
      const k = (a.topic || "").trim() || "(uncategorised)";
      byTopic[k] = byTopic[k] || { approved: 0, rejected: 0 };
      if (isAppr(a)) byTopic[k].approved++; else if (a.status === "rejected") byTopic[k].rejected++;
    });
    const patterns = Object.entries(byTopic).map(([key, v]) => ({
      key, approved: v.approved, rejected: v.rejected,
      rate: Math.round((v.approved / Math.max(1, v.approved + v.rejected)) * 100)
    })).sort((a, b) => (b.approved + b.rejected) - (a.approved + a.rejected));
    const activity = reviewed.filter((a) => a.reviewed_at).slice(0, 25).map((a) => ({
      when: a.reviewed_at, who: a.reviewed_by || "system",
      action: a.status === "rejected" ? "rejected" : (a.status === "sent" ? "sent" : "approved"),
      title: a.title
    }));
    return send(res, {
      model: "gpt-4o",
      memory: {
        embedded: arts.filter((a) => a.suggestion_score != null).length,
        reviewed: reviewed.length,
        rewrites: 0, rewriteGoal: 100,
        pending: arts.filter((a) => a.status === "summarized").length
      },
      patterns,
      accuracy: { scored: arts.filter((a) => a.suggestion_score != null).length, highApprovedPct: 88, lowRejectedPct: 79 },
      activity,
      config: store.aiConfig || { guidance: "", category_prefs: {} }
    });
  }

  if (pathname === "/api/send-article" && req.method === "POST") {
    const b = await readBody(req);
    const a = makeArticle({
      title: b.title || "Submitted article",
      topic: b.topic || "India",
      source: b.source || "Shortly",
      score: 60,
      status: "summarized",
      summary: b.summary || (b.title || "Submitted article")
    }, store.articles.length);
    store.articles.unshift(a);
    return send(res, { article: a });
  }

  return send(res, { error: "not found" }, 404);
}

// ---------- static + server ----------
const types = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith("/api/")) { try { await api(req, res, pathname, url); } catch (e) { send(res, { error: String(e) }, 500); } return; }
  if (pathname === "/config.js") { res.writeHead(200, { "Content-Type": types[".js"] }); return res.end(CONFIG_JS); }

  const filePath = normalize(join(ROOT, decodeURIComponent(pathname === "/" ? "/index.html" : pathname)));
  if (!filePath.startsWith(ROOT) || !existsSync(filePath)) { res.writeHead(404); return res.end("Not found"); }
  const info = await stat(filePath);
  if (!info.isFile()) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": types[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}).listen(PORT, () => {
  console.log(`Shortly PREVIEW (mock data): http://localhost:${PORT}`);
  console.log(`  ${store.articles.filter((a) => a.status === "summarized").length} scored articles in Review, 2 approved, 1 rejected, 2 subscribers.`);
});
