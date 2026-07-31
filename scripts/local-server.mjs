// LOCAL full-stack runner — REAL scraping + REAL GPT-4o summaries, persisted to a
// local JSON store, served to the dashboard. No Supabase, no dummy data.
//   - scrape-news: fetches the real TOI/ET/The Hindu RSS, cleans (fixed cleaner)
//   - summarize-articles: real OpenAI 3-sentence cards (fixed CDATA + line filter)
//   - review-article: approve/reject/edit + the new `category` tag, persisted
// Store: .devdata/local-store.json (survives restarts). Uses OPENAI_API_KEY from .env.
//
// Usage: node scripts/local-server.mjs   ->   http://localhost:4173
//   On first boot (empty store) it auto-scrapes + summarizes ~12 real articles.
//   Re-scrape any time from the dashboard Scraper tab ("Fetch & Summarize").

import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number.parseInt(process.env.PORT || "4173", 10);
const DATA_DIR = resolve(ROOT, ".devdata");
const STORE = join(DATA_DIR, "local-store.json");
const SUMMARIZE_LIMIT = Number(process.env.SUMMARIZE_LIMIT || 12);
const SCRAPE_INTERVAL_HOURS = Number(process.env.SCRAPE_INTERVAL_HOURS || 3);

// ---- env ----
(function loadEnv() {
  const p = resolve(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
})();
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
if (!KEY || KEY.startsWith("YOUR_")) { console.error("OPENAI_API_KEY missing in .env"); process.exit(1); }

// ---- store ----
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
function load() {
  if (!existsSync(STORE)) return { articles: [], subscribers: [], corporateCases: [], editorialDrafts: [], digests: [] };
  try { const s = JSON.parse(readFileSync(STORE, "utf8")); s.articles ??= []; s.subscribers ??= []; s.corporateCases ??= []; s.editorialDrafts ??= []; s.digests ??= []; return s; }
  catch { return { articles: [], subscribers: [], corporateCases: [], editorialDrafts: [], digests: [] }; }
}
let store = load();
function save() { writeFileSync(STORE, JSON.stringify(store, null, 2)); }

// ---- sources (mirror _shared/sources.ts) ----
const SOURCES = [
  { name: "TOI", url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", weight: 1.0, topic: "India" },
  { name: "ET", url: "https://economictimes.indiatimes.com/rssfeedstopstories.cms", weight: 0.95, topic: "India Business" },
  { name: "The Hindu", url: "https://www.thehindu.com/news/national/feeder/default.rss", weight: 1.0, topic: "India" }
];

// ---- RSS parser (CDATA-fixed, mirror _shared/rss.ts) ----
const stripCdata = (s) => s.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim();
const stripTags = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const decode = (s) => s.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&apos;", "'").replaceAll("&nbsp;", " ");
function tagValue(b, t) { const m = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")); if (m) return decode(stripTags(stripCdata(m[1]))).trim(); const m2 = b.match(new RegExp(`<${t}[^>]*href=["']([^"']+)["']`, "i")); return m2 ? m2[1] : ""; }
function parseFeed(xml) {
  const blocks = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi), ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  const out = [];
  for (const b of blocks) { const title = tagValue(b, "title"); const link = tagValue(b, "link") || tagValue(b, "guid"); const description = tagValue(b, "description") || tagValue(b, "summary") || tagValue(b, "content"); if (!title || !link) continue; out.push({ title, url: link, description }); }
  return out;
}

// ---- cleaner (line-filter-fixed, mirror _shared/article-text.ts) ----
const INLINE = [/follow us on [^.?!]*/gi, /join (our|the) (telegram|whatsapp|facebook|instagram|x|twitter|linkedin) [^.?!]*/gi, /subscribe to (our )?(newsletter|channel|alerts)[^.?!]*/gi, /download (our )?app[^.?!]*/gi, /click here[^.?!]*/gi, /read more[^.?!]*/gi, /share (this|the article)[^.?!]*/gi, /advertisement/gi, /published on:\s*/gi, /updated on:\s*/gi];
const FOOTER = [/\b(all rights reserved|copyright|cookie policy|privacy policy|terms of use)\b/i];
const CTA = [/\b(contact us|call us|helpline|hotline|customer care|follow us|subscribe|newsletter|email us|download (the |our )?app|join (our|the) (telegram|whatsapp|facebook|instagram|x|twitter|linkedin)( channel| group)?)\b/i];
const stripHtml = (t) => decode(String(t || "")).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ");
function removeInline(t) { let c = t; for (const p of INLINE) c = c.replace(p, " "); c = c.replace(/https?:\/\/\S+/gi, " "); return c.replace(/\b(?:watch|read|listen)\b\s+on\s+\b(?:youtube|spotify|apple podcasts)\b[^.?!]*/gi, " "); }
const isPhone = (l) => ((l.match(/\d/g) || []).length >= 9) && /^[\d\s()+\-/,.:]+$/.test(l.trim());
const isFurniture = (l) => FOOTER.some((p) => p.test(l)) || (l.length <= 80 && CTA.some((p) => p.test(l)));
function cleanArticleText(text) {
  const plain = removeInline(stripHtml(text)).replace(/\r/g, "\n").replace(/[ \t]+/g, " ");
  return plain.split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => !isFurniture(l)).filter((l) => !isPhone(l)).filter((l) => l.length > 20 || /[.?!]/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").replace(/[ ]{2,}/g, " ").trim();
}
function needsFullArticleFetch(text) { const c = cleanArticleText(text); if (c.length < 320) return true; return [/\b(helpline|contact us|whatsapp|telegram|follow us|subscribe|newsletter)\b/i, /\+\d[\d\s()-]{7,}\d/, /\bprivacy policy\b/i].some((p) => p.test(text)); }
async function fetchReadable(url) { const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; ShortlyScraper/1.0)" } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); const html = await r.text(); const a = html.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i); const b = html.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i); return cleanArticleText(a?.[1] || b?.[1] || html).slice(0, 12000); }

// ---- summarizer (verbatim prompt + flow from summarize-articles) ----
const SYSTEM_PROMPT = `You are a senior editor for a respected daily news briefing read by busy professionals.

Write EXACTLY 3 sentences. 60-90 words total. Active voice.
Sentence 1: Lead with the news — who did what, with key numbers, dates, named entities.
Sentence 2: The critical context.
Sentence 3: The immediate consequence or why it matters.

STRICT RULES:
- Active voice; no filler, no hedging, no editorializing, no emoji, no quotes.
- Preserve specific numbers, percentages, dates, currencies, proper names.
- Ignore page furniture (phones, helplines, contact info, app/newsletter/social prompts, copyright).

Classify "wrapped" (completed) or "ahead" (ongoing/upcoming). Rate prominence 1-5.
Return JSON only: {"summary":"","section":"wrapped","prominence":4}`;
async function summarizeOne(article) {
  let excerpt = cleanArticleText(article.raw_content || "");
  if (excerpt.length < 180 && needsFullArticleFetch(article.raw_content || "")) {
    try { const t = await fetchReadable(article.url); if (t.length > excerpt.length) excerpt = t; } catch { /* keep */ }
  }
  if (excerpt.length > 2200) excerpt = excerpt.slice(0, 2200) + "...";
  const userPrompt = [`TITLE: ${article.title}`, `SOURCE: ${article.source}`, `URL: ${article.url}`, excerpt ? `EXCERPT:\n${excerpt}` : null].filter(Boolean).join("\n\n");
  const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, temperature: 0.3, max_tokens: 220, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userPrompt }] }) });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const raw = (await r.json())?.choices?.[0]?.message?.content?.trim() ?? "";
  try { const p = JSON.parse(raw); return { summary: p.summary ?? raw, section: p.section === "ahead" ? "ahead" : "wrapped", prominence: Math.min(5, Math.max(1, parseInt(p.prominence) || 2)) }; }
  catch { return { summary: raw, section: "wrapped", prominence: 2 }; }
}

// ---- pipeline ----
async function runScrape() {
  const known = new Set(store.articles.map((a) => a.url));
  let added = 0; const errors = [];
  await Promise.all(SOURCES.map(async (src) => {
    try {
      const r = await fetch(src.url, { headers: { "User-Agent": "ShortlyDigestBot/1.0 (+https://shortly.example)" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      for (const it of parseFeed(await r.text())) {
        if (known.has(it.url)) continue; known.add(it.url);
        store.articles.push({ id: randomUUID(), title: it.title.slice(0, 500), url: it.url, raw_content: cleanArticleText(it.description ?? "").slice(0, 4000), source: src.name, topic: src.topic, category: null, section: "wrapped", status: "pending", rank_score: src.weight, summary: null, edited_title: null, edited_summary: null, prominence: null, scraped_at: new Date().toISOString(), summarized_at: null, reviewed_at: null, reviewed_by: null, sent_at: null });
        added++;
      }
    } catch (e) { errors.push({ source: src.name, error: String(e) }); }
  }));
  save();
  return { scraped: added, total: store.articles.length, errors };
}
async function runSummarize(limit = SUMMARIZE_LIMIT) {
  const pending = store.articles.filter((a) => a.status === "pending").sort((a, b) => (b.rank_score ?? 0) - (a.rank_score ?? 0)).slice(0, limit);
  let ok = 0; const failures = [];
  const CONC = 4;
  for (let i = 0; i < pending.length; i += CONC) {
    await Promise.all(pending.slice(i, i + CONC).map(async (a) => {
      try {
        const res = await summarizeOne(a);
        a.summary = res.summary; a.section = res.section; a.prominence = res.prominence;
        const fresh = 1; a.rank_score = Number(a.rank_score ?? 0) * 0.4 + (res.prominence / 5) * 0.3 + fresh * 0.3;
        a.status = "summarized"; a.summarized_at = new Date().toISOString(); ok++;
      } catch (e) { failures.push(String(e).slice(0, 120)); }
    }));
  }
  save();
  return { summarized: ok, failed: failures.length, failures: failures.slice(0, 3) };
}

// ============================================================================
// CATEGORY AGENTS — real per-category scraping + GPT drafting, per the editorial
// docs. Each category fetches its own RSS sources and produces a draft.
// ============================================================================
async function openAiJson(system, user, maxTokens) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, temperature: 0.25, max_tokens: maxTokens, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return JSON.parse((await r.json())?.choices?.[0]?.message?.content?.trim() || "{}");
}
async function fetchCandidates(sources, max = 14) {
  const out = [];
  await Promise.all(sources.map(async (s) => {
    try { const r = await fetch(s.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ShortlyEditorial/1.0)" } }); if (!r.ok) return;
      for (const it of parseFeed(await r.text())) { if (s.accepts && !s.accepts(it.url)) continue; out.push({ source: s.name, title: it.title, url: it.url, excerpt: cleanArticleText(it.description || "").slice(0, 1200) }); }
    } catch { /* skip */ }
  }));
  const seen = new Set();
  return out.filter((x) => x.title && x.url && (seen.has(x.url) ? false : (seen.add(x.url), true))).slice(0, max);
}

// Editorial topic configs (sources + doc rules). RSS-only subset for local runs.
const TOPICS = {
  "real-estate": { name: "Industry: Real Estate", format: "hybrid",
    sources: [{ name: "ET Realty", url: "https://realty.economictimes.indiatimes.com/rss/topstories" }, { name: "Moneycontrol Real Estate", url: "https://www.moneycontrol.com/rss/latestnews.xml", accepts: (u) => /real-estate/i.test(u) }],
    rules: "Real-estate honesty for Indians. Five briefs (launch, completion/handover, builder move, infrastructure, regulation) of 60-80 words each (headline, what_happened, why_it_matters, city), then one thesis (90-110 word summary + 300-500 word detail). Always name the city. Numbers only from the sources. The thesis's first paragraph must credit the source: 'This piece draws on [source]'s reporting.' No invented EMI/yield/price. No exclamation marks." },
  "policy-partner": { name: "Policy Partner", format: "hybrid",
    sources: [{ name: "Bar & Bench", url: "https://www.barandbench.com/feed" }, { name: "Indian Express Explained", url: "https://indianexpress.com/section/explained/feed/" }, { name: "RBI", url: "https://www.rbi.org.in/scripts/RSS.aspx?Id=2000" }],
    rules: "Indian policy in plain English. Five distinct briefs of 60-80 words each (headline, what_happened, why_it_matters), then one explainer (90-110 word summary + 300-500 word detail). Cover policy, courts, regulators, consumer rights, public services or rights where sources allow. Include concrete examples or old-vs-new comparisons. Neutral on parties, sharp on policy. Banned: 'landmark move', 'historic decision', 'sources said', 'it remains to be seen'. No exclamation marks." },
  "money-matters": { name: "Money Matters", format: "hybrid",
    sources: [{ name: "Mint Money", url: "https://www.livemint.com/rss/money" }, { name: "Moneycontrol", url: "https://www.moneycontrol.com/rss/latestnews.xml", accepts: (u) => /business|personal-finance|markets/i.test(u) }, { name: "Business Standard Finance", url: "https://www.business-standard.com/rss/finance-103.rss" }, { name: "RBI", url: "https://www.rbi.org.in/scripts/RSS.aspx?Id=2000" }],
    rules: "Money for Indians who know the basics. Five briefs (regulation, markets/macro with a real why, corporate/deal, personal-finance, scam/enforcement) of 60-80 words each (headline, what_happened, why_it_matters), then one take (90-110 summary + 300-500 detail: what mainstream says, what it misses, what to watch). Numbers only from sources; never compute hypothetical tax/IRR/EMI/returns. Never recommend a product/stock/IPO. Banned: 'wealth-building', 'passive income', 'financial freedom', 'get rich'. End with: 'This isn't investment advice. We don't know your situation. Talk to a SEBI-registered advisor before acting on anything you read here.' No exclamation marks." },
  "wellness-daily": { name: "The Wellness Daily", format: "hybrid",
    sources: [{ name: "The Guardian Wellness", url: "https://www.theguardian.com/lifeandstyle/health-and-wellbeing/rss" }, { name: "Harvard Business Review", url: "https://feeds.hbr.org/harvardbusiness" }],
    rules: "Evidence-led wellness for desk-bound Indian professionals 22-35. Five distinct briefs of 60-80 words each (headline, what_happened, why_it_matters), then one advisory feature (90-110 word summary + 300-500 word detail). Be honest when evidence is thin. Add Indian context without inventing numbers. No drug doses, supplement brands, calorie targets, step goals or weight-loss numbers. A mental-health piece MUST end with: 'If you're struggling, iCall is a free confidential helpline: 9152987821.' Any piece mentioning a medical condition MUST include: 'This isn't medical advice. See a doctor for anything concerning you.' No 'hack'/'game-changer'/'the truth about', no before/after, no exclamation marks." }
};

async function buildEditorialTopic(slug) {
  const cfg = TOPICS[slug];
  if (!cfg) throw new Error(`unknown topic ${slug}`);
  const cands = await fetchCandidates(cfg.sources, 14);
  if (cands.length === 0) throw new Error("no candidates from sources");
  // enrich top items with full text for substance
  const evidence = [];
  for (const c of cands.slice(0, cfg.format === "hybrid" ? 8 : 4)) {
    let text = c.excerpt;
    if (text.length < 400) { try { const t = await fetchReadable(c.url); if (t.length > text.length) text = t.slice(0, 6000); } catch { /* keep */ } }
    evidence.push({ source: c.source, url: c.url, title: c.title, text: text.slice(0, 6000) });
  }
  const shape = cfg.format === "hybrid"
    ? `{"headline":"","briefs":[{"headline":"","what_happened":"","why_it_matters":"","city":"","source_url":""}],"feature":{"headline":"","summary":"","detail":"","source_url":""}}`
    : `{"headline":"","summary":"","detail":"","source_url":""}`;
  const draft = await openAiJson(
    `You are the source-bound drafting agent for ${cfg.name}. Use ONLY facts, names and numbers in the supplied evidence. Paraphrase; at most one quote per source under 15 words.`,
    `RULES: ${cfg.rules}\n\nReturn JSON only in this shape (${cfg.format === "hybrid" ? "exactly 5 briefs" : "single article"}):\n${shape}\n\nEVIDENCE:\n${JSON.stringify(evidence)}`,
    cfg.format === "hybrid" ? 3800 : 2400
  );
  // SPLIT BY FORMAT: short briefs -> Short Articles (articles table, category-tagged);
  // long feature / single-topic article -> Case Studies (editorial_drafts).
  const LABELS = { "real-estate": "Real Estate", "policy-partner": "Policy Partner", "money-matters": "Money Matters", "wellness-daily": "Wellness Daily" };
  const label = LABELS[slug] || cfg.name;
  const srcOf = (u) => evidence.find((e) => e.url === u)?.source || cfg.sources[0]?.name || "Source";
  const fallbackUrl = evidence[0]?.url || "";
  let shortCount = 0;
  const nowIso = () => new Date().toISOString();

  if (cfg.format === "hybrid") {
    for (const b of (Array.isArray(draft.briefs) ? draft.briefs.slice(0, 5) : [])) {
      const body = [b.city ? `${b.city}: ${b.what_happened || ""}` : b.what_happened, b.why_it_matters].filter(Boolean).join("\n\n").trim();
      if (!b.headline || !body) continue;
      store.articles.unshift({ id: randomUUID(), title: String(b.headline).slice(0, 500), url: b.source_url || fallbackUrl, raw_content: body, summary: body, edited_title: null, edited_summary: null, source: srcOf(b.source_url), topic: label, category: label, section: "wrapped", status: "summarized", rank_score: 0.9, prominence: 3, scraped_at: nowIso(), summarized_at: nowIso(), reviewed_at: null, reviewed_by: null, sent_at: null });
      shortCount++;
    }
    if (draft.feature && (draft.feature.summary || draft.feature.detail)) {
      store.editorialDrafts.unshift({ id: randomUUID(), topic_slug: slug, topic_name: cfg.name, format: "single", headline: String(draft.feature.headline || draft.headline || cfg.name), summary: String(draft.feature.summary || ""), detail: String(draft.feature.detail || ""), content: {}, primary_source_url: String(draft.feature.source_url || fallbackUrl), source_links: evidence.map((e) => ({ source: e.source, url: e.url })), status: "draft", generated_at: nowIso() });
    }
  } else {
    // single topic = one long-form piece -> Case Studies
    store.editorialDrafts.unshift({ id: randomUUID(), topic_slug: slug, topic_name: cfg.name, format: "single", headline: String(draft.headline || cfg.name), summary: String(draft.summary || ""), detail: String(draft.detail || ""), content: {}, primary_source_url: String(draft.source_url || fallbackUrl), source_links: evidence.map((e) => ({ source: e.source, url: e.url })), status: "draft", generated_at: nowIso() });
  }
  save();
  return { topic: label, format: cfg.format, shortArticles: shortCount, longToCaseStudies: cfg.format === "hybrid" ? (draft.feature ? 1 : 0) : 1 };
}

async function buildCorporateCase() {
  const CORP = [
    { name: "The Ken", url: "https://the-ken.com/feed/" },
    { name: "Inc42", url: "https://inc42.com/feed/" },
    { name: "Moneycontrol", url: "https://www.moneycontrol.com/rss/latestnews.xml", accepts: (u) => /moneycontrol\.com\/news\/business\//i.test(u) },
    { name: "ET Prime", url: "https://economictimes.indiatimes.com/prime/rssfeeds/837555174.cms" }
  ];
  const blocked = ["/wealth/", "/personal-finance/", "/mutual-funds/", "fixed deposit", "income tax", "stock to buy", "gold price", "home loan"];
  const cands = (await fetchCandidates(CORP, 20)).filter((c) => !blocked.some((b) => `${c.title} ${c.url}`.toLowerCase().includes(b)));
  if (cands.length === 0) throw new Error("no company-case candidates");
  let chosen = null, sourceText = "";
  for (const c of cands.slice(0, 8)) {
    let t = c.excerpt; try { const full = await fetchReadable(c.url); if (full.length > t.length) t = full; } catch { /* keep */ }
    if (t.length >= 1200) { chosen = c; sourceText = t.slice(0, 16000); break; }
  }
  if (!chosen) throw new Error("no candidate had enough public source text");
  const draft = await openAiJson(
    "You are the final drafting voice for Shortly's Corporate Case. Analytical, skeptical, source-bound, concise. Use ONLY facts/numbers in the source text.",
    `RULES: One Indian company, unpacked. Lead with the business model, never the founder; no founder-quote openings. 90-110 word summary (who, what they do, the interesting business question), then 300-500 word detail. The detail's first paragraph must credit the source: 'This case study draws on ${chosen.source}'s reporting. Read the full piece here: ${chosen.url}.' Include at least one comparison/parallel/analogy (flag as inference). Bull case and bear case, weighted — say which side has the numbers and which has the vibes. Honest about luck vs skill. Banned: 'disrupting', '10x growth', 'category-defining', 'rocketship', 'legendary founder', 'this is just the beginning'. No 'lessons for entrepreneurs', no exclamation marks. At most one quote under 15 words.\n\nReturn JSON: {"headline":"","company":"","case_type":"listed|startup|consumer|failure|compounder","summary":"","detail":"","comparison_or_analogy":"","bull_case":"","bear_case":"","open_question":""}\n\nSOURCE: ${chosen.source}\nTITLE: ${chosen.title}\nURL: ${chosen.url}\n\nSOURCE TEXT:\n${sourceText}`,
    2400
  );
  const detail = String(draft.detail || "");
  const credit = `This case study draws on ${chosen.source}'s reporting. Read the full piece here: ${chosen.url}.`;
  const row = {
    id: randomUUID(), source: chosen.source, source_url: chosen.url, source_title: chosen.title,
    company: String(draft.company || "").trim() || null, headline: String(draft.headline || chosen.title),
    case_type: draft.case_type || "startup", summary: String(draft.summary || ""),
    detail: detail.startsWith("This case study draws on") ? detail : `${credit}\n\n${detail}`,
    comparison_or_analogy: draft.comparison_or_analogy || null, bull_case: draft.bull_case || null, bear_case: draft.bear_case || null, open_question: draft.open_question || null,
    status: "draft", generated_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
  const now = new Date().toISOString();
  store.corporateCases.unshift(row);
  store.articles.unshift({
    id: randomUUID(), title: row.headline.slice(0, 500), url: `${row.source_url}#shortly-corporate-case-${row.id}`,
    raw_content: `${row.summary}\n\n${row.detail}`.trim(), summary: row.summary,
    edited_title: null, edited_summary: null, source: row.source, topic: "Corporate Case", category: "Corporate Case",
    section: "wrapped", status: "summarized", rank_score: 0.9, prominence: 3,
    scraped_at: now, summarized_at: now, reviewed_at: null, reviewed_by: null, sent_at: null
  });
  save();
  return row;
}

// ---- http ----
function sendJson(res, body, code = 200) { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { r(d ? JSON.parse(d) : {}); } catch { r({}); } }); }); }
const ALLOWED_CATS = ["Corporate Case", "Real Estate", "Policy Partner", "Money Matters", "Wellness Daily"];

const CONFIG_JS = `// LOCAL real-pipeline config.
window.SHORTLY = {
  list:"/api/list-articles", review:"/api/review-article", digest:"/api/send-daily-digest",
  curatedDigest:"/api/send-curated-digest", topicDigest:"/api/send-topic-digest", submit:"/api/send-article",
  subscribers:"/api/subscribers", scrape:"/api/scrape-news", summarize:"/api/summarize-articles",
  corporateCase:"/api/corporate-case-agent", editorialTopics:"/api/editorial-topic-agent",
  siteUrl:"", twitterUrl:"https://x.com/Shortly_news", linkedinUrl:"", agentAppUrl:"",
  anonKey:"", dailyCap:5, reviewer:"local"
};`;

async function api(req, res, pathname, url) {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "content-type,authorization,apikey,x-agent-token,x-admin-token" }); return res.end(); }

  if (pathname === "/api/list-articles" && req.method === "GET") {
    const status = url.searchParams.get("status") || "summarized";
    const arts = (status === "all" ? store.articles : store.articles.filter((a) => a.status === status)).sort((a, b) => (b.rank_score ?? 0) - (a.rank_score ?? 0));
    const counts = {}; store.articles.forEach((a) => (counts[a.status] = (counts[a.status] || 0) + 1));
    return sendJson(res, { articles: arts, counts });
  }
  if (pathname === "/api/review-article" && req.method === "POST") {
    const b = await readBody(req); const a = store.articles.find((x) => x.id === b.id);
    if (!a) return sendJson(res, { error: "not found" }, 404);
    a.reviewed_at = new Date().toISOString(); a.reviewed_by = b.reviewer || "local";
    if (b.action === "approve") {
      const cat = a.category || "";
      const approvedInCat = store.articles.filter((x) => x.status === "approved" && (x.category || "") === cat).length;
      if (cat && approvedInCat >= 10) return sendJson(res, { error: `Daily limit of 10 reached for ${cat}.` }, 409);
      a.status = "approved";
    } else if (b.action === "reject") a.status = "rejected";
    if (b.section) a.section = b.section;
    if (typeof b.category === "string") a.category = ALLOWED_CATS.includes(b.category.trim()) ? b.category.trim() : null;
    if (b.edited_title) a.edited_title = b.edited_title;
    if (b.edited_summary) a.edited_summary = b.edited_summary;
    if (typeof b.rank_score === "number") a.rank_score = b.rank_score;
    save();
    return sendJson(res, { article: a });
  }
  if (pathname === "/api/scrape-news" && req.method === "POST") return sendJson(res, await runScrape());
  if (pathname === "/api/summarize-articles" && req.method === "POST") return sendJson(res, await runSummarize());
  if (pathname === "/api/send-article" && req.method === "POST") {
    const b = await readBody(req);
    const a = { id: randomUUID(), title: (b.title || "Untitled").slice(0, 500), url: b.url || `https://example.com/${randomUUID().slice(0, 8)}`, raw_content: cleanArticleText(b.raw_content || b.summary || b.title || ""), source: b.source || "Manual", topic: b.topic || "India", category: null, section: "wrapped", status: "pending", rank_score: 1, summary: null, edited_title: null, edited_summary: null, prominence: null, scraped_at: new Date().toISOString(), summarized_at: null, reviewed_at: null, reviewed_by: null, sent_at: null };
    try { const res2 = await summarizeOne(a); a.summary = res2.summary; a.section = res2.section; a.prominence = res2.prominence; a.status = "summarized"; a.summarized_at = new Date().toISOString(); } catch { /* leave pending */ }
    store.articles.unshift(a); save();
    return sendJson(res, { article: a });
  }
  if (pathname === "/api/subscribers") {
    if (req.method === "GET") return sendJson(res, { subscribers: store.subscribers });
    const b = await readBody(req);
    if (b.action === "add") store.subscribers.push({ id: randomUUID(), email: b.email, full_name: b.full_name || null, phone_number: b.phone_number || null, topics: b.topics || ["daily-wrap"], status: "subscribed", created_at: new Date().toISOString() });
    else if (b.action === "update") { const s = store.subscribers.find((x) => x.id === b.id); if (s && b.status) s.status = b.status; if (s && b.topics) s.topics = b.topics; }
    else if (b.action === "delete") store.subscribers = store.subscribers.filter((x) => x.id !== b.id);
    save(); return sendJson(res, { ok: true });
  }
  if (pathname === "/api/corporate-case-agent") {
    if (req.method === "GET") return sendJson(res, { cases: store.corporateCases });
    const b = await readBody(req);
    if (["approve", "reject", "update"].includes(b.action)) {
      const c = store.corporateCases.find((x) => x.id === b.id);
      if (c) {
        if (b.action === "approve") {
          if (store.corporateCases.filter((x) => (x.status || "draft") === "approved").length >= 1) return sendJson(res, { error: "Only 1 Corporate Case can be approved per day." }, 409);
          c.status = "approved";
        } else if (b.action === "reject") c.status = "rejected";
        else { if (b.headline) c.headline = b.headline; if (b.summary) c.summary = b.summary; if (b.detail) c.detail = b.detail; }
        save();
      }
      return sendJson(res, { case: c || null });
    }
    try { const c = await buildCorporateCase(); return sendJson(res, { case: c }); }
    catch (e) { return sendJson(res, { error: String(e.message || e) }, 502); }
  }
  if (pathname === "/api/editorial-topic-agent") {
    if (req.method === "GET") return sendJson(res, { topics: Object.keys(TOPICS).map((s) => ({ slug: s, name: TOPICS[s].name })), drafts: store.editorialDrafts });
    const b = await readBody(req);
    if (["approve", "reject", "update"].includes(b.action)) {
      const d = store.editorialDrafts.find((x) => x.id === b.id);
      if (d) {
        if (b.action === "approve") {
          if (store.editorialDrafts.filter((x) => x.topic_slug === d.topic_slug && (x.status || "draft") === "approved").length >= 1) return sendJson(res, { error: `Only 1 ${d.topic_name} draft can be approved per day.` }, 409);
          d.status = "approved";
        } else if (b.action === "reject") d.status = "rejected";
        else { if (b.headline) d.headline = b.headline; }
        save();
      }
      return sendJson(res, { draft: d || null });
    }
    try { const d = await buildEditorialTopic(b.topic); return sendJson(res, { draft: d }); }
    catch (e) { return sendJson(res, { error: String(e.message || e) }, 502); }
  }
  if (["/api/send-daily-digest", "/api/send-curated-digest", "/api/send-topic-digest"].includes(pathname) && req.method === "POST")
    return sendJson(res, { mock: true, sent: store.subscribers.length, failed: 0 });
  return sendJson(res, { error: "not found" }, 404);
}

const types = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
createServer(async (req, res) => {
  const u = new URL(req.url || "/", `http://${req.headers.host}`);
  if (u.pathname.startsWith("/api/")) { try { await api(req, res, u.pathname, u); } catch (e) { sendJson(res, { error: String(e) }, 500); } return; }
  if (u.pathname === "/config.js") { res.writeHead(200, { "Content-Type": types[".js"] }); return res.end(CONFIG_JS); }
  const fp = normalize(join(ROOT, decodeURIComponent(u.pathname === "/" ? "/index.html" : u.pathname)));
  if (!fp.startsWith(ROOT) || !existsSync(fp)) { res.writeHead(404); return res.end("Not found"); }
  const info = await stat(fp);
  if (!info.isFile()) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": types[extname(fp)] || "application/octet-stream" });
  createReadStream(fp).pipe(res);
}).listen(PORT, async () => {
  console.log(`Shortly LOCAL (real scrape + real GPT-4o): http://localhost:${PORT}`);
  console.log(`Auto-pipeline: every ${SCRAPE_INTERVAL_HOURS} hours (scrape + summarize + build all categories).`);
  const haveCategories = store.articles.some((a) => a.category);
  const sinceLast = store.lastPipelineRun ? (Date.now() - store.lastPipelineRun) : Infinity;
  const staleMs = SCRAPE_INTERVAL_HOURS * 60 * 60 * 1000;
  if (!haveCategories || sinceLast > Math.min(staleMs, 30 * 60 * 1000)) {
    console.log("Auto-running pipeline now (categories empty or last run was a while ago)...");
    runFullPipeline();
  } else {
    console.log(`  fresh (last run ${Math.round(sinceLast / 60000)} min ago). Next auto-run within ${SCRAPE_INTERVAL_HOURS}h.`);
  }
  // Auto-run every N hours — no manual clicking needed.
  setInterval(runFullPipeline, SCRAPE_INTERVAL_HOURS * 60 * 60 * 1000);
});

let pipelineRunning = false;
async function runFullPipeline() {
  if (pipelineRunning) { console.log("[auto] skipped — previous run still going"); return; }
  pipelineRunning = true;
  const t = new Date().toISOString();
  console.log(`[auto ${t}] scrape -> summarize -> build categories`);
  try { const s = await runScrape(); console.log(`  scraped ${s.scraped}`); } catch (e) { console.log(`  scrape failed: ${e.message}`); }
  try { const z = await runSummarize(); console.log(`  summarized ${z.summarized}`); } catch (e) { console.log(`  summarize failed: ${e.message}`); }
  for (const slug of Object.keys(TOPICS)) {
    try { const r = await buildEditorialTopic(slug); console.log(`  built ${slug}: ${r.shortArticles} briefs, ${r.longToCaseStudies} long`); }
    catch (e) { console.log(`  build ${slug} failed: ${e.message}`); }
  }
  try { const c = await buildCorporateCase(); console.log(`  built corporate: ${c.company || c.headline}`); } catch (e) { console.log(`  corporate failed: ${e.message}`); }
  store.lastPipelineRun = Date.now(); save();
  console.log(`[auto] done`);
  pipelineRunning = false;
}
