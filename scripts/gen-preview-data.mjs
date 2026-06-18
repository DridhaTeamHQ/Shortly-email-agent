// Generates REAL GPT-4o summaries for the preview seed articles, using the exact
// production prompt (SYSTEM_PROMPT + buildUserPrompt from _shared.mjs).
// Writes scripts/preview-data.json which preview-server.mjs loads.
//
// Run once (or whenever you change the seed): node scripts/gen-preview-data.mjs
// Reads OPENAI_API_KEY from .env.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, ROOT, buildUserPrompt, chat } from "./_shared.mjs";
loadEnv();
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
if (!KEY) { console.error("OPENAI_API_KEY missing in .env"); process.exit(1); }
const today = new Date().toISOString().slice(0, 10);

const SEED = [
  { title: "India unveils ₹1.2 lakh crore semiconductor mission", topic: "India Business", source: "ET", score: 92, status: "summarized",
    raw: "The Union Cabinet approved a ₹1.2 lakh crore semiconductor mission to build three new fabrication plants and attract global chipmakers. The scheme offers capital subsidies and aims to create about 90,000 jobs over five years." },
  { title: "RBI keeps repo rate at 6.5%, signals data-dependent path", topic: "India Business", source: "TOI", score: 88, status: "summarized",
    raw: "The Reserve Bank of India held the repo rate at 6.5% for the eighth straight meeting, citing sticky food inflation. The governor said future moves depend on incoming data, and retained the GDP growth forecast at 7%." },
  { title: "Monsoon arrives early over Kerala, IMD confirms", topic: "India", source: "The Hindu", score: 81, status: "summarized",
    raw: "The southwest monsoon reached Kerala two days ahead of schedule, the India Meteorological Department said. IMD forecast above-normal rainfall this season, easing concerns for kharif sowing." },
  { title: "Supreme Court upholds electoral bonds verdict", topic: "India", source: "TOI", score: 77, status: "summarized",
    raw: "The Supreme Court declined to review its earlier judgment striking down the electoral bonds scheme. The bench said transparency in political funding outweighs donor anonymity." },
  { title: "Sensex closes above 82,000 for first time", topic: "Business", source: "ET", score: 71, status: "summarized",
    raw: "The BSE Sensex closed above 82,000 for the first time, gaining 1.1% led by IT and banking stocks. Strong foreign investor inflows and easing US bond yields drove the rally." },
  { title: "ISRO sets date for Gaganyaan crewed test flight", topic: "India", source: "The Hindu", score: 66, status: "summarized",
    raw: "ISRO announced the first crewed Gaganyaan test flight is targeted for early next year. The mission will carry three astronauts to low-earth orbit for a three-day flight." },
  { title: "Delhi air quality dips to 'very poor' ahead of winter", topic: "India", source: "TOI", score: 58, status: "summarized",
    raw: "Delhi's air quality index slipped into the 'very poor' category as stubble burning and falling temperatures trapped pollutants. Authorities restricted construction and diesel generators." },
  { title: "Global oil prices ease as OPEC+ weighs output", topic: "World", source: "Shortly", score: 47, status: "summarized",
    raw: "Brent crude slipped 2% as OPEC+ signaled it may raise output next quarter. Traders weighed softer demand from China against Middle East supply risks." },
  { title: "US Fed minutes hint at slower rate cuts", topic: "World", source: "Shortly", score: 38, status: "summarized",
    raw: "Minutes from the US Federal Reserve meeting showed officials favor fewer rate cuts this year amid persistent services inflation. Markets trimmed bets on a near-term cut." },
  { title: "Premier League transfer rumor roundup", topic: "World", source: "Shortly", score: 22, status: "summarized",
    raw: "Several Premier League clubs are linked with summer moves for midfielders, according to reports. No official bids have been confirmed by the clubs involved." },
  { title: "Hollywood star spotted at Mumbai airport", topic: "World", source: "Shortly", score: 15, status: "summarized",
    raw: "A Hollywood actor was photographed arriving at Mumbai airport, sparking fan speculation about an upcoming project. No official announcement has been made." },
  { title: "Local cricket club wins district trophy", topic: "India", source: "Shortly", score: 11, status: "summarized",
    raw: "A local cricket club won the district-level trophy after a close final. The team's captain credited consistent practice and youth coaching." },
  { title: "Cabinet approves new rail freight corridor", topic: "India", source: "TOI", score: 90, status: "approved",
    raw: "The Union Cabinet approved a new dedicated rail freight corridor worth ₹45,000 crore connecting two major ports. The project aims to cut logistics costs and is targeted for completion by 2030." },
  { title: "State budget raises health spending 18%", topic: "India Business", source: "ET", score: 85, status: "approved",
    raw: "The state budget raised health spending by 18%, allocating funds for new district hospitals and medical colleges. The finance minister said the focus is on primary care access." },
  { title: "Foreign celebrity divorce dominates feeds", topic: "World", source: "Shortly", score: 14, status: "rejected",
    raw: "A foreign celebrity couple announced their divorce, drawing heavy social media attention. Representatives asked for privacy during the transition." }
];

const CONCURRENCY = 5;
const out = [];
console.log(`Generating ${SEED.length} real summaries (${MODEL})...`);
for (let i = 0; i < SEED.length; i += CONCURRENCY) {
  const batch = SEED.slice(i, i + CONCURRENCY);
  const done = await Promise.all(batch.map(async (s) => {
    const article = { title: s.title, source: s.source, url: "https://example.com/preview", raw_content: s.raw, scraped_at: today + "T06:00:00Z" };
    const r = await chat(KEY, MODEL, buildUserPrompt(article));
    console.log(`  ${r.summary.length}c | ${s.title.slice(0, 45)}`);
    return { ...s, summary: r.summary, section: r.section, prominence: r.prominence };
  }));
  out.push(...done);
}
writeFileSync(resolve(ROOT, "scripts/preview-data.json"), JSON.stringify(out, null, 2));
console.log(`\nWrote scripts/preview-data.json (${out.length} articles).`);
