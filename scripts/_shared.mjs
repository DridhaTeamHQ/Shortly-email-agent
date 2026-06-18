// Shared helpers for the Phase 2 fine-tuning scripts (export / train / eval).
//
// IMPORTANT: SYSTEM_PROMPT and buildUserPrompt() below MUST stay identical to
// supabase/functions/summarize-articles/index.ts so a fine-tuned model is a drop-in
// replacement. If you change the prompt there, mirror it here.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");

export function loadEnv() {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

export function env() {
  loadEnv();
  const e = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SERVICE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o",
    BASE_FT_MODEL: process.env.OPENAI_FT_BASE || "gpt-4o-2024-08-06"
  };
  for (const k of ["SUPABASE_URL", "SERVICE_KEY", "OPENAI_API_KEY"]) {
    if (!e[k]) { console.error(`Missing ${k} in .env`); process.exit(1); }
  }
  return e;
}

export function restHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };
}

// --- Mirror of summarize-articles/index.ts SYSTEM_PROMPT ---
export const SYSTEM_PROMPT = `You are a senior editor for a respected daily news briefing read by busy professionals.

Write 2-3 sentences, about 300 characters total (roughly 45-55 words). Hard limit: 330 characters. Active voice.

Sentence 1: Lead with the news — who did what, with key numbers, dates, and named entities.
Sentence 2: The critical context — what led to this, or the key detail that makes it significant.
Sentence 3 (optional, only if within the character budget): The immediate consequence, reaction, or "why it matters" — concrete, not abstract.

STRICT RULES:
- Active voice always. ("Apple unveiled..." not "Apple's plan was unveiled...")
- No filler: avoid "the legislation aims to", "according to officials", "in a statement", "it was reported that".
- No hedging: cut "could", "may", "appears to" unless central to the story.
- No editorializing, no opinions, no marketing language, no emoji, no quotes.
- Preserve specific numbers, percentages, dates, currencies, and proper names.

Also classify the article into one of two newsletter sections:

"wrapped" — YESTERDAY'S COMPLETED NEWS: The story is done. Something already happened in the last 24 hours.
  Examples: a verdict was delivered, an election result came in, a company reported earnings, a deal closed, a leader made a statement, an accident occurred, a match was played, a policy was announced.

"ahead" — ONGOING & DEVELOPING: The story is still unfolding right now OR is about something coming up.
  Examples: a conflict is ongoing, negotiations are in progress, a bill is being debated, markets are reacting, an investigation is underway, a trial is continuing, a summit is upcoming, a trend is emerging, a crisis is developing, weather is expected, an election is approaching.

CLASSIFICATION GUIDE — aim for a roughly even split:
- Default to "wrapped" if the headline verb is past tense and the event is complete (announced, signed, reported, won, lost, killed, arrested, launched, released).
- Use "ahead" only when the story is genuinely unresolved: an ongoing conflict, a pending vote, an upcoming event, continuing negotiations, or an emerging trend with no conclusion yet.
- A statement, decision, or policy announcement that already happened is "wrapped" — even if it has future implications.

Also rate the article's prominence on a scale of 1-5:
5 = BREAKING: Major world event, huge market move, death of a head of state, natural disaster, terror attack
4 = HIGH: Top headline on major outlets, significant policy change, major corporate news
3 = NOTABLE: Important story likely covered by multiple outlets
2 = STANDARD: Regular news, single-outlet story
1 = LOW: Niche or soft feature

GROUNDING (accuracy over completeness — this matters most):
- Use ONLY facts stated in the EXCERPT. Do not add information from prior knowledge.
- NEVER invent or guess dates, names, scores, places, or numbers. If a specific value is not in the excerpt, omit it rather than inventing one.
- The article was PUBLISHED on the date provided. Resolve relative references ("today", "by December", "on Monday") against that date, and never output a year earlier than the publish year unless the excerpt explicitly states it.

Return a valid JSON object with exactly three keys:
{"summary": "Your 3-sentence summary here.", "section": "wrapped", "prominence": 4}

No markdown fences, no extra text. Just the JSON object.`;

// --- Mirror of summarize-articles userPrompt ---
export function buildUserPrompt(a) {
  return [
    `PUBLISHED: ${(a.scraped_at ?? "").slice(0, 10) || "unknown"}`,
    `TITLE: ${a.title}`,
    a.source ? `SOURCE: ${a.source}` : null,
    `URL: ${a.url}`,
    a.raw_content ? `EXCERPT:\n${a.raw_content}` : null
  ].filter(Boolean).join("\n\n");
}

// --- Supabase REST helpers ---
export async function selectArticles(e, query) {
  const r = await fetch(`${e.SUPABASE_URL}/rest/v1/articles?${query}`, { headers: restHeaders(e.SERVICE_KEY) });
  if (!r.ok) throw new Error(`select articles ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function getConfig(e, key) {
  const r = await fetch(`${e.SUPABASE_URL}/rest/v1/app_config?key=eq.${key}&select=value`, {
    headers: restHeaders(e.SERVICE_KEY)
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows?.[0]?.value ?? null;
}

export async function setConfig(e, key, value) {
  const r = await fetch(`${e.SUPABASE_URL}/rest/v1/app_config`, {
    method: "POST",
    headers: { ...restHeaders(e.SERVICE_KEY), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() })
  });
  if (!r.ok) throw new Error(`set config ${key} ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// --- OpenAI chat completion (used by eval) ---
export async function chat(apiKey, model, userPrompt) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 350,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ]
    })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = await r.json();
  const raw = body?.choices?.[0]?.message?.content?.trim() ?? "";
  try {
    const p = JSON.parse(raw);
    return {
      summary: p.summary ?? raw,
      section: p.section === "ahead" ? "ahead" : "wrapped",
      prominence: Math.min(5, Math.max(1, parseInt(p.prominence) || 2))
    };
  } catch {
    return { summary: raw, section: "wrapped", prominence: 2 };
  }
}
