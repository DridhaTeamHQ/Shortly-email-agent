// Seed the dev server with REAL live articles from public RSS feeds.
// Pulls today's headlines from BBC, AP, NYT — so "Open source ↗" links actually work.
// Usage: node scripts/seed.mjs [count]
// Default count = 12.

const BASE = process.env.BASE || "http://localhost:4173";
const TARGET = Number(process.argv[2] || 12);

const FEEDS = [
  { name: "BBC", topic: "World",      url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "BBC", topic: "Business",   url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { name: "BBC", topic: "Technology", url: "https://feeds.bbci.co.uk/news/technology/rss.xml" },
  { name: "NYT", topic: "World",      url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
  { name: "NYT", topic: "Business",   url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml" },
  { name: "NYT", topic: "Technology", url: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml" },
  { name: "AP",  topic: "World",      url: "https://feeds.apnews.com/rss/apf-topnews" }
];

const stripCdata = (s) => s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
const stripTags = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const decode = (s) =>
  s.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
   .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&apos;", "'");
const tag = (block, t) => {
  const m = block.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i"));
  if (m) return decode(stripTags(stripCdata(m[1]))).trim();
  const m2 = block.match(new RegExp(`<${t}[^>]*href=["']([^"']+)["']`, "i"));
  return m2 ? m2[1] : "";
};

async function pullFeed(feed) {
  try {
    const r = await fetch(feed.url, { headers: { "User-Agent": "ShortlyDev/1.0" } });
    if (!r.ok) return [];
    const xml = await r.text();
    const blocks = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
    return blocks.slice(0, 4).map((b) => ({
      title: tag(b, "title"),
      url: tag(b, "link") || tag(b, "guid"),
      source: feed.name,
      topic: feed.topic,
      raw_content: tag(b, "description") || tag(b, "summary")
    })).filter((a) => a.title && a.url);
  } catch (e) {
    console.log(`  ! ${feed.name} ${feed.topic} feed failed: ${e.message}`);
    return [];
  }
}

console.log("Fetching live RSS feeds...");
const all = (await Promise.all(FEEDS.map(pullFeed))).flat();
console.log(`  Got ${all.length} candidates from ${FEEDS.length} feeds`);

// Round-robin pick across sources so the queue is diverse
const bySrc = {};
all.forEach((a) => { (bySrc[`${a.source}/${a.topic}`] ??= []).push(a); });
const picks = [];
let added = true;
while (picks.length < TARGET && added) {
  added = false;
  for (const k of Object.keys(bySrc)) {
    if (picks.length >= TARGET) break;
    const next = bySrc[k].shift();
    if (next) { picks.push(next); added = true; }
  }
}

console.log(`\nSubmitting ${picks.length} articles to ${BASE}...`);
let ok = 0, fail = 0;
for (const a of picks) {
  try {
    const r = await fetch(BASE + "/api/submit-article", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(a)
    });
    const data = await r.json();
    if (r.ok) {
      ok++;
      console.log(`  ✓ [${a.source}] ${a.title.slice(0, 70)}`);
    } else {
      fail++;
      console.log(`  ✗ ${data.error}: ${a.title.slice(0, 50)}`);
    }
  } catch (e) {
    fail++;
    console.log(`  ✗ ${e.message}`);
  }
}
console.log(`\nDone: ${ok} ok, ${fail} failed (duplicates count as failed)`);
