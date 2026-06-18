// Validate candidate RSS feeds for the newsletter sources spreadsheet.
// For each source, tries candidate feed URLs and reports the first that returns
// parseable RSS/Atom items. Output guides what goes into _shared/sources.ts.
// Usage: node scripts/validate-feeds.mjs

const UA = "ShortlyDigestBot/1.0 (+https://shortlyindia.com)";

// [category, name, region, weight, [candidate feed urls...]]
const CANDIDATES = [
  // Tech & AI
  ["Tech & AI", "Inc42", "India", 1.0, ["https://inc42.com/feed/"]],
  ["Tech & AI", "Medianama", "India", 0.9, ["https://www.medianama.com/feed/"]],
  ["Tech & AI", "ET Tech", "India", 0.95, ["https://tech.economictimes.indiatimes.com/rss/topstories"]],
  ["Tech & AI", "The Verge", "Global", 0.85, ["https://www.theverge.com/rss/index.xml"]],
  ["Tech & AI", "Wired", "Global", 0.85, ["https://www.wired.com/feed/rss"]],
  ["Tech & AI", "TechCrunch AI", "Global", 0.85, ["https://techcrunch.com/category/artificial-intelligence/feed/"]],
  // Jobs & Careers
  ["Jobs & Careers", "ET HRWorld", "India", 1.0, ["https://hr.economictimes.indiatimes.com/rss/topstories"]],
  ["Jobs & Careers", "Business Standard", "India", 0.95, ["https://www.business-standard.com/rss/home_page_top_stories.rss", "https://www.business-standard.com/rss/latest.rss"]],
  ["Jobs & Careers", "Moneycontrol", "India", 0.9, ["https://www.moneycontrol.com/rss/latestnews.xml"]],
  ["Jobs & Careers", "Bloomberg Work Shift", "Global", 0.8, ["https://www.bloomberg.com/work-shift/rss", "https://feeds.bloomberg.com/work-shift/news.rss"]],
  ["Jobs & Careers", "Harvard Business Review", "Global", 0.85, ["https://feeds.hbr.org/harvardbusiness", "http://feeds.hbr.org/harvardbusiness"]],
  ["Jobs & Careers", "Naukri Blog", "India", 0.8, ["https://www.naukri.com/blog/feed/"]],
  ["Jobs & Careers", "LinkedIn News", "Global", 0.8, ["https://www.linkedin.com/news/rss"]],
  // Health & Wellness
  ["Health & Wellness", "ET HealthWorld", "India", 1.0, ["https://health.economictimes.indiatimes.com/rss/topstories"]],
  ["Health & Wellness", "Pharmabiz", "India", 0.85, ["https://www.pharmabiz.com/rss.aspx", "https://www.pharmabiz.com/feed/"]],
  ["Health & Wellness", "ICMR News", "India", 0.85, ["https://www.icmr.gov.in/feed", "https://www.icmr.gov.in/rss.xml"]],
  ["Health & Wellness", "WHO Newsroom", "Global", 0.9, ["https://www.who.int/rss-feeds/news-english.xml"]],
  ["Health & Wellness", "Harvard Health Blog", "Global", 0.85, ["https://www.health.harvard.edu/blog/feed"]],
  ["Health & Wellness", "Cleveland Clinic", "Global", 0.85, ["https://health.clevelandclinic.org/feed"]],
  ["Health & Wellness", "Medical Xpress", "Global", 0.8, ["https://medicalxpress.com/rss-feed/"]],
  // Money & Finance
  ["Money & Finance", "Mint Markets & Economy", "India", 1.0, ["https://www.livemint.com/rss/markets"]],
  ["Money & Finance", "Financial Express Economy", "India", 0.95, ["https://www.financialexpress.com/economy/feed/"]],
  ["Money & Finance", "ET Markets", "India", 0.95, ["https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms"]],
  ["Money & Finance", "ET Wealth", "India", 0.9, ["https://economictimes.indiatimes.com/wealth/rssfeeds/837555174.cms"]],
  ["Money & Finance", "Mint Money", "India", 0.9, ["https://www.livemint.com/rss/money"]],
  ["Money & Finance", "Moneycontrol Markets", "India", 0.9, ["https://www.moneycontrol.com/rss/marketreports.xml", "https://www.moneycontrol.com/rss/business.xml"]],
  ["Money & Finance", "Reuters Business", "Global", 0.8, ["https://www.reuters.com/business/rss", "https://feeds.reuters.com/reuters/businessNews"]],
  // Climate & Sustainability
  ["Climate & Sustainability", "Down To Earth", "India", 1.0, ["https://www.downtoearth.org.in/rss", "https://www.downtoearth.org.in/feed"]],
  ["Climate & Sustainability", "Mongabay India", "India", 0.9, ["https://india.mongabay.com/feed/"]],
  ["Climate & Sustainability", "Reuters Sustainability", "Global", 0.8, ["https://www.reuters.com/sustainability/rss"]],
  ["Climate & Sustainability", "Bloomberg Green", "Global", 0.8, ["https://www.bloomberg.com/green/rss", "https://feeds.bloomberg.com/green/news.rss"]],
  ["Climate & Sustainability", "Carbon Brief", "Global", 0.85, ["https://www.carbonbrief.org/feed/"]],
  // Culture & Cinema
  ["Culture & Cinema", "Film Companion", "India", 0.9, ["https://www.filmcompanion.in/feed/"]],
  ["Culture & Cinema", "The Hindu Entertainment", "India", 0.95, ["https://www.thehindu.com/entertainment/feeder/default.rss"]],
  ["Culture & Cinema", "Scroll Culture", "India", 0.85, ["https://feeds.feedburner.com/ScrollinArticles", "https://scroll.in/feed"]],
  ["Culture & Cinema", "The Hollywood Reporter", "Global", 0.8, ["https://www.hollywoodreporter.com/feed/"]],
  ["Culture & Cinema", "The Caravan", "India", 0.85, ["https://caravanmagazine.in/feed", "https://caravanmagazine.in/rss"]],
  ["Culture & Cinema", "Variety", "Global", 0.8, ["https://variety.com/feed/"]],
  // Automobile & EV
  ["Automobile & EV", "Autocar India", "India", 0.95, ["https://www.autocarindia.com/rss/news", "https://www.autocarindia.com/feed"]],
  ["Automobile & EV", "ET Auto", "India", 0.95, ["https://auto.economictimes.indiatimes.com/rss/topstories"]],
  ["Automobile & EV", "Overdrive", "India", 0.85, ["https://www.overdrive.in/feed/"]],
  ["Automobile & EV", "Autocar Professional", "India", 0.85, ["https://www.autocarpro.in/rss", "https://www.autocarpro.in/feed"]],
  ["Automobile & EV", "EVreporter", "India", 0.85, ["https://evreporter.com/feed/"]]
];

function itemCount(xml) {
  const items = (xml.match(/<item[\s>]/gi) || []).length;
  const entries = (xml.match(/<entry[\s>]/gi) || []).length;
  return items + entries;
}

async function tryUrl(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml,application/xml,text/xml,*/*" }, redirect: "follow", signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const text = await r.text();
    const n = itemCount(text);
    if (n === 0) return { ok: false, reason: "no items (not RSS?)" };
    return { ok: true, n };
  } catch (e) {
    return { ok: false, reason: String(e.name === "AbortError" ? "timeout" : e).slice(0, 60) };
  }
}

const ok = [], fail = [];
for (const [cat, name, region, weight, urls] of CANDIDATES) {
  let chosen = null;
  for (const u of urls) {
    const res = await tryUrl(u);
    if (res.ok) { chosen = { cat, name, region, weight, url: u, n: res.n }; break; }
  }
  if (chosen) { ok.push(chosen); console.log(`OK   ${name.padEnd(26)} ${chosen.n} items  ${chosen.url}`); }
  else { fail.push({ cat, name, urls }); console.log(`FAIL ${name.padEnd(26)} tried: ${urls.join(" , ")}`); }
}

console.log(`\n=== ${ok.length} OK, ${fail.length} FAILED ===`);
console.log("\nWorking feeds (paste-ready):");
ok.forEach((s) => console.log(`{ category: ${JSON.stringify(s.cat)}, name: ${JSON.stringify(s.name)}, url: ${JSON.stringify(s.url)}, region: ${JSON.stringify(s.region)}, weight: ${s.weight} },`));
if (fail.length) { console.log("\nFailed (no working feed found):"); fail.forEach((f) => console.log(`  ${f.cat} / ${f.name}`)); }
