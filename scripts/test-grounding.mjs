// Local A/B check: CURRENT production prompt vs a GROUNDED prompt, on real prod articles.
// Goal: confirm the date/fact hallucination finding and whether grounding fixes it.
// Uses OPENAI_API_KEY from .env. Read-only — calls OpenAI, writes nothing to the DB.
//
// Usage: node scripts/test-grounding.mjs

import { loadEnv, SYSTEM_PROMPT, buildUserPrompt } from "./_shared.mjs";
loadEnv();
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
if (!KEY) { console.error("OPENAI_API_KEY missing in .env"); process.exit(1); }

// Articles editors had to FACT-CORRECT in prod (the genuine summary rewrites).
// `model_was`/`editor_fixed` show what the production model produced vs the human fix.
const ARTICLES = [
  { title: "500 ethanol pumps by year-end: Union minister Hardeep Singh Puri", source: "TOI", topic: "India", scraped_date: "2026-06-05",
    raw_content: "India is set to significantly expand its ethanol dispensing stations, with 500 planned by December and 5,000 by 2027, to boost flex-fuel vehicle adoption. This initiative, marked by the launch of Maruti Suzuki's WagonR flex-fuel car, aims to reduce fuel imports. The government is implementing supportive measures including pricing incentives and infrastructure development.",
    model_was: "...establish 500 ethanol pumps by December 2023...", editor_fixed: "...by December 2026..." },
  { title: "Blood test can predict lung cancer 5 years before diagnosis", source: "TOI", topic: "India", scraped_date: "2026-06-06",
    raw_content: "Scientists found blood markers that can predict lung cancer more than five years in advance. This breakthrough could help detect the disease early in India, where most cases are found late. A 14-protein signature in blood identified individuals at higher risk. This finding may lead to earlier monitoring and preventive measures for lung cancer.",
    model_was: "(no date error; editor added the 80-85% stat)", editor_fixed: "added 'in 80-85% patients'" },
  { title: "Bill proposes ending H-1B path to permanent residency and eliminating OPT program", source: "TOI", topic: "India", scraped_date: "2026-06-07",
    raw_content: "U.S. Representative Chip Roy has introduced the \"American White-Collar Worker Jobs Act of 2026\" to reform the H-1B visa program. The bill aims to end H-1B visas as a path to permanent residency and eliminate the Optional Practical Training (OPT) program. It seeks to prioritize American STEM professionals by enforcing stricter wage standards and preventing displacement of U.S. workers.",
    model_was: "(editor added '(Green card)' clarification)", editor_fixed: "added '(Green card)'" }
];

// Grounded system prompt = production prompt + anti-hallucination grounding rules.
const GROUNDED_SYSTEM = SYSTEM_PROMPT + `

GROUNDING (CRITICAL — accuracy over completeness):
- Use ONLY facts stated in the EXCERPT. Do not add information from prior knowledge.
- NEVER invent or guess dates, names, scores, places, or numbers. If a specific value is not in the excerpt, omit it rather than inventing one.
- The article was PUBLISHED on the date given. Resolve relative references ("today", "on Monday") against that date, and never output a year earlier than the publish year unless the excerpt explicitly states it.`;

function groundedUserPrompt(a) {
  return `PUBLISHED: ${a.scraped_date}\n\n` + buildUserPrompt(a);
}

async function run(system, user) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0.3, max_tokens: 350,
      messages: [{ role: "system", content: system }, { role: "user", content: user }] })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0,200)}`);
  const raw = (await r.json())?.choices?.[0]?.message?.content?.trim() ?? "";
  try { const p = JSON.parse(raw); return p.summary ?? raw; } catch { return raw; }
}

// Flag years that aren't the publish year (likely hallucinated).
function dateFlags(text, pubYear) {
  const years = [...text.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => m[0]);
  const bad = years.filter((y) => y !== pubYear);
  return { years, bad };
}

async function main() {
  console.log(`Model: ${MODEL}  |  A/B: current prompt vs grounded prompt\n`);
  for (const a of ARTICLES) {
    const pubYear = a.scraped_date.slice(0, 4);
    console.log("=".repeat(80));
    console.log(`TITLE: ${a.title}\nPUBLISHED: ${a.scraped_date}`);
    if (a.model_was) console.log(`(prod model was: ${a.model_was}  |  editor fixed: ${a.editor_fixed})`);

    const cur = await run(SYSTEM_PROMPT, buildUserPrompt(a));
    const grd = await run(GROUNDED_SYSTEM, groundedUserPrompt(a));

    const cf = dateFlags(cur, pubYear);
    const gf = dateFlags(grd, pubYear);

    console.log(`\n[CURRENT]  ${cur}`);
    console.log(`  chars: ${cur.length}   dates: ${cf.years.join(", ") || "none"}${cf.bad.length ? `   ⚠ SUSPECT: ${cf.bad.join(", ")}` : ""}`);
    console.log(`\n[GROUNDED] ${grd}`);
    console.log(`  chars: ${grd.length}   dates: ${gf.years.join(", ") || "none"}${gf.bad.length ? `   ⚠ SUSPECT: ${gf.bad.join(", ")}` : ""}`);
    console.log();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
