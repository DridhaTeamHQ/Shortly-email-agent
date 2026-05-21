// Local test for the GPT-4o summarization prompt.
// Usage:
//   node scripts/test-summarize.mjs                 -> runs on built-in sample articles
//   node scripts/test-summarize.mjs --rss           -> pulls 3 live articles from BBC RSS
//   node scripts/test-summarize.mjs --url <url>     -> summarize a single URL (title + page text)
// Requires Node 18+ (built-in fetch). Reads OPENAI_API_KEY and OPENAI_MODEL from .env.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ---- tiny .env loader (no deps) ----
function loadEnv() {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}
loadEnv();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY missing in .env");
  process.exit(1);
}

const SYSTEM_PROMPT = `You are a senior news editor for a professional daily digest.
Summarize the article in EXACTLY 2-3 sentences (max ~70 words).
Tone: neutral, factual, polished. No marketing language, no opinions, no emoji.
Lead with the most important fact. Include named entities, numbers, and dates when present.
Return ONLY the summary text. No preface, no quotes, no markdown.`;

const SAMPLES = [
  {
    title: "European Central Bank holds rates steady, signals data-dependent path",
    source: "Reuters",
    url: "https://example.com/ecb-hold",
    raw_content:
      "The European Central Bank kept its benchmark deposit rate at 3.75% on Thursday after a quarter-point cut at its previous meeting, saying inflation in the euro zone remains uneven and that future moves would depend on incoming data. President Christine Lagarde said wage growth is moderating but services inflation remains 'sticky' at around 4%. Markets are pricing two more cuts before the end of the year."
  },
  {
    title: "Apple unveils on-device AI features for iPhone, partners with OpenAI for fallback",
    source: "BBC",
    url: "https://example.com/apple-ai",
    raw_content:
      "Apple announced a suite of generative AI features for the iPhone at its developer conference on Monday, branded 'Apple Intelligence'. The features run on-device for privacy and include writing tools, image generation, and a more capable Siri. For complex queries the system can hand off to ChatGPT, in a partnership with OpenAI announced at the same event. The features will ship later this year on iPhone 15 Pro and newer."
  },
  {
    title: "UN warns Sudan famine has expanded to five regions, threatens 25 million",
    source: "AP",
    url: "https://example.com/sudan-famine",
    raw_content:
      "The United Nations said on Tuesday that famine conditions in Sudan have spread to five regions, with about 25 million people - roughly half the population - facing acute food insecurity after 18 months of war between the army and the Rapid Support Forces. Aid groups say convoys are being blocked at multiple checkpoints. Secretary-General Antonio Guterres called for an immediate humanitarian ceasefire."
  }
];

async function summarize(article) {
  const userPrompt = [
    `TITLE: ${article.title}`,
    article.source ? `SOURCE: ${article.source}` : null,
    `URL: ${article.url}`,
    article.raw_content ? `EXCERPT:\n${article.raw_content}` : null
  ]
    .filter(Boolean)
    .join("\n\n");

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 180,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ]
    })
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`OpenAI ${r.status}: ${text.slice(0, 300)}`);
  }
  const body = await r.json();
  return body?.choices?.[0]?.message?.content?.trim();
}

// minimal RSS pull (BBC) for live test
async function loadRss(n = 3) {
  const url = "https://feeds.bbci.co.uk/news/world/rss.xml";
  const r = await fetch(url, { headers: { "User-Agent": "ShortlyTest/1.0" } });
  const xml = await r.text();
  const blocks = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const stripCdata = (s) => s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
  const stripTags = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const decode = (s) =>
    s.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
  const tag = (b, t) => {
    const m = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i"));
    return m ? decode(stripTags(stripCdata(m[1]))).trim() : "";
  };
  return blocks.slice(0, n).map((b) => ({
    title: tag(b, "title"),
    url: tag(b, "link"),
    source: "BBC",
    raw_content: tag(b, "description")
  }));
}

// crude page-text fetch for --url
async function fetchPage(url) {
  const r = await fetch(url, { headers: { "User-Agent": "ShortlyTest/1.0" } });
  const html = await r.text();
  const title = (html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? url).trim();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
  return { title, url, source: new URL(url).hostname, raw_content: text };
}

async function main() {
  const args = process.argv.slice(2);
  let articles = SAMPLES;
  if (args[0] === "--rss") {
    console.log("Pulling 3 live BBC articles...");
    articles = await loadRss(3);
  } else if (args[0] === "--url" && args[1]) {
    console.log(`Fetching ${args[1]}...`);
    articles = [await fetchPage(args[1])];
  }

  for (const a of articles) {
    console.log("\n" + "=".repeat(78));
    console.log("TITLE :", a.title);
    console.log("SOURCE:", a.source);
    console.log("URL   :", a.url);
    try {
      const t0 = Date.now();
      const s = await summarize(a);
      const ms = Date.now() - t0;
      console.log(`\nSUMMARY (${MODEL}, ${ms}ms):\n${s}`);
      console.log(`Words: ${s.split(/\s+/).length}`);
    } catch (e) {
      console.error("FAILED:", e.message);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
