// Local dry-run of the daily news scraper. Mirrors supabase/functions/scrape-news
// exactly (same SOURCES, same parseFeed from _shared/rss.ts, same cleanArticleText
// from _shared/article-text.ts) so you can SEE what it fetches and how it cleans
// BEFORE anything is written to the database. Writes nothing — read-only.
//
// Usage:
//   node scripts/test-scrape.mjs            # summary + 2 samples per source
//   node scripts/test-scrape.mjs --full     # show every item's cleaned raw_content
//   node scripts/test-scrape.mjs --raw      # also show the RAW (pre-clean) description

const FULL = process.argv.includes("--full");
const SHOW_RAW = process.argv.includes("--raw");

// ---- SOURCES (mirror of _shared/sources.ts) ----
const SOURCES = [
  { name: "TOI", url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", weight: 1.0, topic: "India" },
  { name: "ET", url: "https://economictimes.indiatimes.com/rssfeedstopstories.cms", weight: 0.95, topic: "India Business" },
  { name: "The Hindu", url: "https://www.thehindu.com/news/national/feeder/default.rss", weight: 1.0, topic: "India" }
];

// ---- parseFeed (verbatim from _shared/rss.ts) ----
const stripCdata = (s) => s.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim();
const stripTags = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const decode = (s) => s
  .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
  .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&apos;", "'").replaceAll("&nbsp;", " ");
function tagValue(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (m) return decode(stripTags(stripCdata(m[1]))).trim();
  const m2 = block.match(new RegExp(`<${tag}[^>]*href=["']([^"']+)["']`, "i"));
  if (m2) return m2[1];
  return "";
}
function parseFeed(xml) {
  const blocks = [
    ...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)
  ].map((m) => m[0]);
  const items = [];
  for (const block of blocks) {
    const title = tagValue(block, "title");
    const link = tagValue(block, "link") || tagValue(block, "guid");
    const description = tagValue(block, "description") || tagValue(block, "summary") || tagValue(block, "content");
    const publishedAt = tagValue(block, "pubDate") || tagValue(block, "published") || tagValue(block, "updated") || null;
    if (!title || !link) continue;
    items.push({ title, url: link, description, publishedAt });
  }
  return items;
}

// ---- cleanArticleText (verbatim from _shared/article-text.ts) ----
const INLINE_NOISE_PATTERNS = [
  /follow us on [^.?!]*/gi, /join (our|the) (telegram|whatsapp|facebook|instagram|x|twitter|linkedin) [^.?!]*/gi,
  /subscribe to (our )?(newsletter|channel|alerts)[^.?!]*/gi, /download (our )?app[^.?!]*/gi,
  /click here[^.?!]*/gi, /read more[^.?!]*/gi, /share (this|the article)[^.?!]*/gi,
  /advertisement/gi, /published on:\s*/gi, /updated on:\s*/gi
];
const FOOTER_LINE_PATTERNS = [/\b(all rights reserved|copyright|cookie policy|privacy policy|terms of use)\b/i];
const CTA_LINE_PATTERNS = [/\b(contact us|call us|helpline|hotline|customer care|follow us|subscribe|newsletter|email us|download (the |our )?app|join (our|the) (telegram|whatsapp|facebook|instagram|x|twitter|linkedin)( channel| group)?)\b/i];
const CTA_MAX_LINE_LENGTH = 80;
function isFurnitureLine(line) {
  if (FOOTER_LINE_PATTERNS.some((p) => p.test(line))) return true;
  if (line.length <= CTA_MAX_LINE_LENGTH && CTA_LINE_PATTERNS.some((p) => p.test(line))) return true;
  return false;
}
function decodeEntities(text) {
  return text.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&apos;", "'").replaceAll("&nbsp;", " ");
}
function stripHtml(text) {
  return decodeEntities(String(text || ""))
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ");
}
function removeInlineNoise(text) {
  let cleaned = text;
  for (const p of INLINE_NOISE_PATTERNS) cleaned = cleaned.replace(p, " ");
  cleaned = cleaned.replace(/https?:\/\/\S+/gi, " ");
  cleaned = cleaned.replace(/\b(?:watch|read|listen)\b\s+on\s+\b(?:youtube|spotify|apple podcasts)\b[^.?!]*/gi, " ");
  return cleaned;
}
function isMostlyPhoneLine(line) {
  const digits = (line.match(/\d/g) || []).length;
  return digits >= 9 && /^[\d\s()+\-/,.:]+$/.test(line.trim());
}
function cleanArticleText(text) {
  const plain = removeInlineNoise(stripHtml(text)).replace(/\r/g, "\n").replace(/[ \t]+/g, " ");
  const lines = plain.split("\n").map((l) => l.trim()).filter(Boolean)
    .filter((l) => !isFurnitureLine(l))
    .filter((l) => !isMostlyPhoneLine(l))
    .filter((l) => l.length > 20 || /[.?!]/.test(l));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/[ ]{2,}/g, " ").trim();
}
function needsFullArticleFetch(text) {
  const cleaned = cleanArticleText(text);
  if (cleaned.length < 320) return true;
  const noisy = [/\b(helpline|contact us|whatsapp|telegram|follow us|subscribe|newsletter)\b/i, /\+\d[\d\s()-]{7,}\d/, /\bprivacy policy\b/i];
  return noisy.some((p) => p.test(text));
}

// ---- run ----
async function main() {
  const allRows = [];
  const errors = [];
  console.log("Daily news scrape — DRY RUN (no DB writes)\n");

  for (const src of SOURCES) {
    try {
      const r = await fetch(src.url, { headers: { "User-Agent": "ShortlyDigestBot/1.0 (+https://shortly.example)" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const items = parseFeed(await r.text());
      const rows = items.map((item) => ({
        title: item.title.slice(0, 500),
        url: item.url,
        rawDescription: item.description ?? "",
        raw_content: cleanArticleText(item.description ?? "").slice(0, 4000),
        source: src.name,
        topic: src.topic ?? null,
        rank_score: src.weight,
        status: "pending"
      }));
      allRows.push(...rows);
      const needFetch = rows.filter((x) => needsFullArticleFetch(x.rawDescription)).length;
      console.log(`── ${src.name}  (${src.topic})  →  ${rows.length} items, ${needFetch} would need full-page fetch (excerpt too short/noisy)`);

      const sample = FULL ? rows : rows.slice(0, 2);
      for (const row of sample) {
        console.log(`\n  • ${row.title}`);
        console.log(`    url: ${row.url}`);
        if (SHOW_RAW) console.log(`    RAW   (${row.rawDescription.length}c): ${row.rawDescription.slice(0, 240)}${row.rawDescription.length > 240 ? "…" : ""}`);
        console.log(`    CLEAN (${row.raw_content.length}c): ${row.raw_content.slice(0, 280)}${row.raw_content.length > 280 ? "…" : ""}`);
      }
      console.log("");
    } catch (e) {
      errors.push({ source: src.name, error: String(e) });
      console.log(`── ${src.name}  →  FAILED: ${e.message}`);
    }
  }

  // dedupe by url (mirror of scrape-news)
  const seen = new Set();
  const unique = allRows.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));

  // ---- diagnostics ----
  const feedEmpty = unique.filter((r) => r.rawDescription.trim().length < 20).length;
  const cleanerKilled = unique.filter((r) => r.rawDescription.trim().length >= 60 && r.raw_content.length < 20).length;
  const usable = unique.filter((r) => r.raw_content.length >= 100).length;
  const cdataLeak = unique.filter((r) => /\]\]>/.test(r.title)).length;

  console.log("──────────────────────────────────────────");
  console.log(`scraped: ${allRows.length}   unique-after-dedupe: ${unique.length}   would-insert(pending): ${unique.length}`);
  console.log("\nDIAGNOSTICS:");
  console.log(`  feed gave no description (needs full-page fetch): ${feedEmpty}`);
  console.log(`  CLEANER DESTROYED real text (raw>=60 -> clean<20): ${cleanerKilled}   <-- BUG`);
  console.log(`  titles with ]]> CDATA leak: ${cdataLeak}   <-- BUG`);
  console.log(`  usable raw_content (>=100 chars): ${usable} / ${unique.length}`);
  if (errors.length) console.log("errors:", JSON.stringify(errors));

  // show the cleaner-destroyed examples (the actionable bug)
  const killed = unique.filter((r) => r.rawDescription.trim().length >= 60 && r.raw_content.length < 20).slice(0, 6);
  if (killed.length) {
    console.log("\nExamples the cleaner wrongly emptied (real news mentioning telegram/whatsapp/video/etc.):");
    for (const r of killed) console.log(`  • [${r.source}] ${r.title.slice(0, 70)}\n      raw: "${r.rawDescription.slice(0, 120)}..."`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
