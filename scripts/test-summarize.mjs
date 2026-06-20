// Local dry-run of the FULL daily pipeline up to the GPT cards:
//   scrape (3 sources) -> clean -> [full-page fetch when excerpt thin] -> summarize.
// Mirrors supabase/functions/scrape-news + summarize-articles + _shared exactly.
// Writes NOTHING to the DB. Uses OPENAI_API_KEY from .env for the summarizer.
//
// Usage:
//   node scripts/test-summarize.mjs            # (a) fetch test + (b) 6 GPT cards
//   node scripts/test-summarize.mjs --cards 10 # summarize more articles

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv() {
  const p = resolve(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv();
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
if (!KEY) { console.error("OPENAI_API_KEY missing in .env"); process.exit(1); }
const CARD_COUNT = Number((process.argv[process.argv.indexOf("--cards") + 1]) || 6);

const SOURCES = [
  { name: "TOI", url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", weight: 1.0, topic: "India" },
  { name: "ET", url: "https://economictimes.indiatimes.com/rssfeedstopstories.cms", weight: 0.95, topic: "India Business" },
  { name: "The Hindu", url: "https://www.thehindu.com/news/national/feeder/default.rss", weight: 1.0, topic: "India" }
];

// ---- parser (mirror _shared/rss.ts, with the CDATA fix) ----
const stripCdata = (s) => s.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim();
const stripTags = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const decode = (s) => s.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&apos;", "'").replaceAll("&nbsp;", " ");
function tagValue(b, t) {
  const m = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i"));
  if (m) return decode(stripTags(stripCdata(m[1]))).trim();
  const m2 = b.match(new RegExp(`<${t}[^>]*href=["']([^"']+)["']`, "i"));
  return m2 ? m2[1] : "";
}
function parseFeed(xml) {
  const blocks = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi), ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  const out = [];
  for (const b of blocks) {
    const title = tagValue(b, "title");
    const link = tagValue(b, "link") || tagValue(b, "guid");
    const description = tagValue(b, "description") || tagValue(b, "summary") || tagValue(b, "content");
    if (!title || !link) continue;
    out.push({ title, url: link, description });
  }
  return out;
}

// ---- cleaner (mirror _shared/article-text.ts, with the line-filter fix) ----
const INLINE = [/follow us on [^.?!]*/gi, /join (our|the) (telegram|whatsapp|facebook|instagram|x|twitter|linkedin) [^.?!]*/gi, /subscribe to (our )?(newsletter|channel|alerts)[^.?!]*/gi, /download (our )?app[^.?!]*/gi, /click here[^.?!]*/gi, /read more[^.?!]*/gi, /share (this|the article)[^.?!]*/gi, /advertisement/gi, /published on:\s*/gi, /updated on:\s*/gi];
const FOOTER = [/\b(all rights reserved|copyright|cookie policy|privacy policy|terms of use)\b/i];
const CTA = [/\b(contact us|call us|helpline|hotline|customer care|follow us|subscribe|newsletter|email us|download (the |our )?app|join (our|the) (telegram|whatsapp|facebook|instagram|x|twitter|linkedin)( channel| group)?)\b/i];
const decE = (t) => t.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&apos;", "'").replaceAll("&nbsp;", " ");
const stripHtml = (t) => decE(String(t || "")).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ");
function removeInline(t) { let c = t; for (const p of INLINE) c = c.replace(p, " "); c = c.replace(/https?:\/\/\S+/gi, " "); return c.replace(/\b(?:watch|read|listen)\b\s+on\s+\b(?:youtube|spotify|apple podcasts)\b[^.?!]*/gi, " "); }
const isPhone = (l) => ((l.match(/\d/g) || []).length >= 9) && /^[\d\s()+\-/,.:]+$/.test(l.trim());
const isFurniture = (l) => FOOTER.some((p) => p.test(l)) || (l.length <= 80 && CTA.some((p) => p.test(l)));
function cleanArticleText(text) {
  const plain = removeInline(stripHtml(text)).replace(/\r/g, "\n").replace(/[ \t]+/g, " ");
  return plain.split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => !isFurniture(l)).filter((l) => !isPhone(l)).filter((l) => l.length > 20 || /[.?!]/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").replace(/[ ]{2,}/g, " ").trim();
}
function needsFullArticleFetch(text) {
  const c = cleanArticleText(text);
  if (c.length < 320) return true;
  return [/\b(helpline|contact us|whatsapp|telegram|follow us|subscribe|newsletter)\b/i, /\+\d[\d\s()-]{7,}\d/, /\bprivacy policy\b/i].some((p) => p.test(text));
}
async function fetchReadableArticleText(url) {
  const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; ShortlyScraper/1.0)" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  const a = html.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
  const b = html.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i);
  return cleanArticleText(a?.[1] || b?.[1] || html).slice(0, 12000);
}

// ---- summarizer (verbatim system prompt + flow from summarize-articles) ----
const SYSTEM_PROMPT = `You are a senior editor for a respected daily news briefing read by busy professionals.

Write EXACTLY 3 sentences. 60-90 words total. Active voice.

Sentence 1: Lead with the news — who did what, with key numbers, dates, and named entities.
Sentence 2: The critical context — what led to this, or the key detail that makes it significant.
Sentence 3: The immediate consequence, reaction, or "why it matters" — concrete, not abstract.

STRICT RULES:
- Active voice always.
- No filler, no hedging, no editorializing, no emoji, no quotes.
- Preserve specific numbers, percentages, dates, currencies, and proper names.
- Ignore page furniture: phone numbers, helplines, contact info, app prompts, newsletters, social prompts, copyright lines.

Classify into "wrapped" (completed news) or "ahead" (ongoing/upcoming). Rate prominence 1-5.
Return JSON only: {"summary":"","section":"wrapped","prominence":4}`;

async function summarize(article) {
  let excerpt = cleanArticleText(article.raw_content || "");
  let fetched = false;
  if (excerpt.length < 180 && needsFullArticleFetch(article.raw_content || "")) {
    try { const readable = await fetchReadableArticleText(article.url); if (readable.length > excerpt.length) { excerpt = readable; fetched = true; } } catch { /* keep excerpt */ }
  }
  if (excerpt.length > 2200) excerpt = excerpt.slice(0, 2200) + "...";
  const userPrompt = [`TITLE: ${article.title}`, `SOURCE: ${article.source}`, `URL: ${article.url}`, excerpt ? `EXCERPT:\n${excerpt}` : null].filter(Boolean).join("\n\n");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0.3, max_tokens: 220, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userPrompt }] })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const raw = (await r.json())?.choices?.[0]?.message?.content?.trim() ?? "";
  let out; try { const p = JSON.parse(raw); out = { summary: p.summary ?? raw, section: p.section === "ahead" ? "ahead" : "wrapped", prominence: Math.min(5, Math.max(1, parseInt(p.prominence) || 2)) }; } catch { out = { summary: raw, section: "wrapped", prominence: 2 }; }
  return { ...out, fetched, excerptLen: excerpt.length };
}

async function scrape() {
  const rows = [];
  for (const src of SOURCES) {
    try {
      const r = await fetch(src.url, { headers: { "User-Agent": "ShortlyDigestBot/1.0 (+https://shortly.example)" } });
      const items = parseFeed(await r.text());
      for (const it of items) rows.push({ title: it.title.slice(0, 500), url: it.url, raw_content: cleanArticleText(it.description ?? "").slice(0, 4000), rawDesc: it.description ?? "", source: src.name, topic: src.topic, rank_score: src.weight });
    } catch (e) { console.log(`scrape ${src.name} failed: ${e.message}`); }
  }
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
}

const wc = (s) => (s || "").trim().split(/\s+/).filter(Boolean).length;

async function main() {
  console.log(`Pipeline dry-run (model: ${MODEL}) — no DB writes\n`);
  const rows = await scrape();
  console.log(`Scraped ${rows.length} unique articles.\n`);

  // (a) Full-page fetch test on empty-description items
  const empties = rows.filter((r) => r.raw_content.length < 180 && needsFullArticleFetch(r.rawDesc)).slice(0, 15);
  console.log(`=== (a) Full-page fetch test — ${empties.length} thin/empty items ===`);
  let ok = 0, fail = 0, totalLen = 0;
  for (const r of empties) {
    try { const t = await fetchReadableArticleText(r.url); if (t.length >= 250) { ok++; totalLen += t.length; } else { fail++; } }
    catch { fail++; }
  }
  console.log(`  retrievable (>=250 chars): ${ok}/${empties.length}   avg ${ok ? Math.round(totalLen / ok) : 0} chars   blocked/thin: ${fail}\n`);

  // (b) Summarizer cards — mix of sources, top by weight
  console.log(`=== (b) Summarizer cards (real prompt) — ${CARD_COUNT} articles ===`);
  const pick = [];
  for (const src of ["TOI", "ET", "The Hindu"]) {
    pick.push(...rows.filter((r) => r.source === src).slice(0, Math.ceil(CARD_COUNT / 3)));
  }
  for (const a of pick.slice(0, CARD_COUNT)) {
    try {
      const c = await summarize(a);
      console.log(`\n[${a.source}] ${a.title}`);
      console.log(`  ${c.summary}`);
      console.log(`  → ${wc(c.summary)} words · ${c.section} · prominence ${c.prominence}${c.fetched ? " · (full-page fetched)" : ""}`);
    } catch (e) {
      console.log(`\n[${a.source}] ${a.title}\n  FAILED: ${e.message}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
