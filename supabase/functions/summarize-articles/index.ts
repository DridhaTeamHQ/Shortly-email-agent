// summarize-articles: take recent `pending` articles, summarize with GPT-4o,
// promote top 50 of the day to `summarized` (ready for QA review).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { cleanArticleText, fetchReadableArticleText, needsFullArticleFetch } from "../_shared/article-text.ts";

const SYSTEM_PROMPT = `You are a senior editor for a respected daily news briefing read by busy professionals.

Write EXACTLY 3 sentences. 60-90 words total. Active voice.

Sentence 1: Lead with the news — who did what, with key numbers, dates, and named entities.
Sentence 2: The critical context — what led to this, or the key detail that makes it significant.
Sentence 3: The immediate consequence, reaction, or "why it matters" — concrete, not abstract.

STRICT RULES:
- Active voice always. ("Apple unveiled..." not "Apple's plan was unveiled...")
- No filler: avoid "the legislation aims to", "according to officials", "in a statement", "it was reported that".
- No hedging: cut "could", "may", "appears to" unless central to the story.
- No editorializing, no opinions, no marketing language, no emoji, no quotes.
- Preserve specific numbers, percentages, dates, currencies, and proper names.
- Ignore page furniture: phone numbers, helplines, contact info, app prompts, newsletters, social prompts, copyright lines, and subscription banners are not part of the news story.
- If the excerpt is noisy or incomplete, extract the core news event only. Never repeat raw phone numbers unless they are central to the story itself.

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

Return a valid JSON object with exactly three keys:
{"summary": "Your 3-sentence summary here.", "section": "wrapped", "prominence": 4}

No markdown fences, no extra text. Just the JSON object.`;

type Article = {
  id: string;
  title: string;
  url: string;
  raw_content: string | null;
  source: string | null;
  rank_score: number | null;
  scraped_at: string;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const openAiKey = requiredEnv("OPENAI_API_KEY");
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Pull recent pending articles — only last 10 hours for freshness
  const since = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
  const { data: pending, error } = await supabase
    .from("articles")
    .select("id,title,url,raw_content,source,rank_score,scraped_at")
    .eq("status", "pending")
    .gte("scraped_at", since)
    .order("rank_score", { ascending: false })
    .order("scraped_at", { ascending: false })
    .limit(50);

  if (error) return json({ error: error.message }, 500);

  const articles = (pending ?? []) as Article[];
  if (articles.length === 0) return json({ summarized: 0, message: "No pending articles" });

  // Summarize in parallel (capped) to keep within edge time budget
  const CONCURRENCY = 2;
  const results: Array<{ id: string; summary: string | null; section: string; prominence: number; error?: string }> = [];

  for (let i = 0; i < articles.length; i += CONCURRENCY) {
    const batch = articles.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (a) => {
        try {
          const result = await summarize(openAiKey, model, a);
          return { id: a.id, summary: result.summary, section: result.section, prominence: result.prominence };
        } catch (e) {
          return { id: a.id, summary: null, section: "wrapped", prominence: 2, error: String(e) };
        }
      })
    );
    results.push(...settled);
  }

  // Persist summaries + rank using prominence + freshness
  const now = Date.now();
  const updates = results
    .filter((r) => r.summary)
    .map((r) => {
      const a = articles.find((x) => x.id === r.id)!;
      const ageHours = (now - new Date(a.scraped_at).getTime()) / 3_600_000;
      const freshness = Math.max(0, 1 - ageHours / 10);
      // Score = 40% source weight + 30% prominence + 30% freshness
      const prominenceNorm = (r.prominence ?? 2) / 5;
      const score = Number(a.rank_score ?? 0) * 0.4 + prominenceNorm * 0.3 + freshness * 0.3;
      return {
        id: a.id,
        summary: r.summary!,
        section: r.section,
        prominence: r.prominence,
        rank_score: score,
        status: "summarized",
        summarized_at: new Date().toISOString()
      };
    });

  // Update in chunks
  for (const row of updates) {
    await supabase.from("articles").update({
      summary: row.summary,
      section: row.section,
      prominence: row.prominence,
      rank_score: row.rank_score,
      status: row.status,
      summarized_at: row.summarized_at
    }).eq("id", row.id);
  }

  // Topic-diverse top 50 — bonus on rank for the best per source
  // (Simple approach: keep them all as `summarized`; QA picks 10. The top-50 cap
  // is enforced by re-ranking and demoting overflow back to `pending`.)
  const topIds = updates
    .sort((a, b) => b.rank_score - a.rank_score)
    .slice(0, 50)
    .map((r) => r.id);

  if (topIds.length > 0) {
    // Anything summarized today that isn't in top 50 → back to pending (kept as history)
    const { data: tooMany } = await supabase
      .from("articles")
      .select("id")
      .eq("status", "summarized")
      .not("id", "in", `(${topIds.join(",")})`);
    if (tooMany && tooMany.length > 0) {
      await supabase
        .from("articles")
        .update({ status: "pending" })
        .in("id", tooMany.map((r) => r.id));
    }
  }

  const failed = results.filter((r) => !r.summary);
  return json({
    summarized: updates.length,
    top_50: topIds.length,
    failed: failed.length,
    failures: failed.slice(0, 5)
  });
});

async function summarize(apiKey: string, model: string, article: Article): Promise<{ summary: string; section: string; prominence: number }> {
  const cleanedExcerpt = cleanArticleText(article.raw_content || "");
  let excerpt = cleanedExcerpt;

  if (cleanedExcerpt.length < 180 && needsFullArticleFetch(article.raw_content || "")) {
    try {
      const readable = await fetchReadableArticleText(article.url);
      if (readable.length > excerpt.length) excerpt = readable;
    } catch {
      // Keep the cleaned RSS excerpt if page extraction fails.
    }
  }

  if (excerpt.length > 2200) {
    excerpt = `${excerpt.slice(0, 2200)}...`;
  }

  const userPrompt = [
    `TITLE: ${article.title}`,
    article.source ? `SOURCE: ${article.source}` : null,
    `URL: ${article.url}`,
    excerpt ? `EXCERPT:\n${excerpt}` : null
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 220,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI ${response.status}: ${text.slice(0, 200)}`);
  }

  const body = await response.json();
  const raw = body?.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("empty completion");

  // Parse JSON response from GPT
  try {
    const parsed = JSON.parse(raw);
    const section = parsed.section === "ahead" ? "ahead" : "wrapped";
    const prominence = Math.min(5, Math.max(1, parseInt(parsed.prominence) || 2));
    return { summary: parsed.summary ?? raw, section, prominence };
  } catch {
    // Fallback: treat entire response as summary, default to wrapped
    return { summary: raw, section: "wrapped", prominence: 2 };
  }
}
