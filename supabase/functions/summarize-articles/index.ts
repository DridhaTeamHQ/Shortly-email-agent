// summarize-articles: take recent `pending` articles, summarize with GPT-4o,
// promote top 50 of the day to `summarized` (ready for QA review).
//
// Self-learning (RAG) additions:
//  - Embed each article's raw input (title + excerpt) BEFORE summarizing.
//  - Retrieve the nearest editor-rewritten past examples and inject them as few-shot
//    guidance so the new summary already matches house style.
//  - Score each article's approve-likelihood from labelled neighbours (advisory).
//  - Persist embedding + suggestion_score + suggestion_meta on the row.
// All RAG steps are best-effort: any failure falls back to today's behaviour.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";

const SYSTEM_PROMPT = `You are a senior editor for a respected daily news briefing read by busy professionals.

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

type Article = {
  id: string;
  title: string;
  url: string;
  raw_content: string | null;
  source: string | null;
  topic: string | null;
  rank_score: number | null;
  scraped_at: string;
};

type Neighbor = {
  id: string;
  title: string;
  edited_title: string | null;
  summary: string | null;
  edited_summary: string | null;
  section: string | null;
  status: string;
  similarity: number;
};

type SummaryResult = {
  id: string;
  summary: string | null;
  section: string;
  prominence: number;
  embedding: string | null;
  suggestion_score: number | null;
  suggestion_meta: unknown | null;
  error?: string;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const openAiKey = requiredEnv("OPENAI_API_KEY");
  const embedModel = Deno.env.get("OPENAI_EMBED_MODEL") ?? "text-embedding-3-small";

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Config-aware: model, human editorial guidance, and per-category preferences
  // all come from app_config (set via the AI Brain dashboard).
  let model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
  let guidance = "";
  let categoryPrefs: Record<string, string> = {};
  try {
    const { data: cfgRows } = await supabase
      .from("app_config")
      .select("key,value")
      .in("key", ["OPENAI_MODEL", "EDITORIAL_GUIDANCE", "CATEGORY_PREFS"]);
    for (const row of cfgRows ?? []) {
      if (row.key === "OPENAI_MODEL" && row.value) model = row.value;
      else if (row.key === "EDITORIAL_GUIDANCE" && row.value) guidance = row.value;
      else if (row.key === "CATEGORY_PREFS" && row.value) {
        try { categoryPrefs = JSON.parse(row.value); } catch { /* ignore */ }
      }
    }
  } catch {
    // app_config may not exist yet; keep env/defaults.
  }
  // boost = +0.15 rank, suppress = -0.25 rank (applied after base scoring)
  const prefDelta = (topic: string | null): number => {
    const p = categoryPrefs[(topic ?? "").trim()];
    return p === "boost" ? 0.15 : p === "suppress" ? -0.25 : 0;
  };

  // Pull recent pending articles — only last 10 hours for freshness
  const since = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
  const { data: pending, error } = await supabase
    .from("articles")
    .select("id,title,url,raw_content,source,topic,rank_score,scraped_at")
    .eq("status", "pending")
    .gte("scraped_at", since)
    .order("rank_score", { ascending: false })
    .order("scraped_at", { ascending: false })
    .limit(120);

  if (error) return json({ error: error.message }, 500);

  const articles = (pending ?? []) as Article[];
  if (articles.length === 0) return json({ summarized: 0, message: "No pending articles" });

  // Summarize in parallel (capped) to keep within edge time budget
  const CONCURRENCY = 6;
  const results: SummaryResult[] = [];
  let scoredCount = 0;
  let fewShotCount = 0;

  for (let i = 0; i < articles.length; i += CONCURRENCY) {
    const batch = articles.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (a): Promise<SummaryResult> => {
        // --- RAG: embed raw input first (best-effort) ---
        let vecLiteral: string | null = null;
        let examples: Neighbor[] = [];
        try {
          const embedInput = `${a.title}\n${(a.raw_content ?? "").slice(0, 2000)}`.trim();
          const vec = await embed(openAiKey, embedModel, embedInput);
          vecLiteral = JSON.stringify(vec);
          examples = await matchArticles(supabase, vecLiteral, 4, true, a.id);
          if (examples.length > 0) fewShotCount++;
        } catch {
          vecLiteral = null;
          examples = [];
        }

        try {
          const result = await summarize(openAiKey, model, a, examples, guidance);

          // --- RAG: advisory score from labelled neighbours (best-effort) ---
          let suggestion_score: number | null = null;
          let suggestion_meta: unknown | null = null;
          if (vecLiteral) {
            try {
              const neighbors = await matchArticles(supabase, vecLiteral, 8, false, a.id);
              const scored = scoreFromNeighbors(neighbors);
              suggestion_score = scored.score;
              suggestion_meta = scored.meta;
              if (suggestion_score != null) scoredCount++;
            } catch {
              // ignore scoring failure
            }
          }

          return {
            id: a.id,
            summary: result.summary,
            section: result.section,
            prominence: result.prominence,
            embedding: vecLiteral,
            suggestion_score,
            suggestion_meta
          };
        } catch (e) {
          return {
            id: a.id,
            summary: null,
            section: "wrapped",
            prominence: 2,
            embedding: vecLiteral,
            suggestion_score: null,
            suggestion_meta: null,
            error: String(e)
          };
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
      // Score = 40% source weight + 30% prominence + 30% freshness, then the
      // human's per-category preference (boost/suppress) nudges it.
      const prominenceNorm = (r.prominence ?? 2) / 5;
      const score = Number(a.rank_score ?? 0) * 0.4 + prominenceNorm * 0.3 + freshness * 0.3 + prefDelta(a.topic);
      return {
        id: a.id,
        summary: r.summary!,
        section: r.section,
        prominence: r.prominence,
        rank_score: score,
        status: "summarized",
        summarized_at: new Date().toISOString(),
        embedding: r.embedding,
        suggestion_score: r.suggestion_score,
        suggestion_meta: r.suggestion_meta
      };
    });

  // Update in chunks
  for (const row of updates) {
    const patch: Record<string, unknown> = {
      summary: row.summary,
      section: row.section,
      prominence: row.prominence,
      rank_score: row.rank_score,
      status: row.status,
      summarized_at: row.summarized_at,
      suggestion_score: row.suggestion_score,
      suggestion_meta: row.suggestion_meta
    };
    // Only write embedding when we actually computed one (don't null out on failure).
    if (row.embedding) patch.embedding = row.embedding;
    await supabase.from("articles").update(patch).eq("id", row.id);
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
    scored: scoredCount,
    few_shot_used: fewShotCount,
    model,
    failed: failed.length,
    failures: failed.slice(0, 5)
  });
});

// --- OpenAI embeddings ---
async function embed(apiKey: string, model: string, text: string): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text })
  });
  if (!response.ok) {
    const t = await response.text().catch(() => "");
    throw new Error(`OpenAI embed ${response.status}: ${t.slice(0, 200)}`);
  }
  const body = await response.json();
  const vec = body?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error("empty embedding");
  return vec;
}

// --- Vector search over reviewed articles via the match_articles RPC ---
async function matchArticles(
  supabase: ReturnType<typeof createClient>,
  vecLiteral: string | null,
  k: number,
  wantEdited: boolean,
  excludeId: string | null
): Promise<Neighbor[]> {
  if (!vecLiteral) return [];
  try {
    const { data, error } = await supabase.rpc("match_articles", {
      query_embedding: vecLiteral,
      match_count: k,
      want_edited: wantEdited,
      exclude_id: excludeId
    });
    if (error) return [];
    return (data ?? []) as Neighbor[];
  } catch {
    return [];
  }
}

// --- Advisory approve-likelihood from labelled neighbours ---
function scoreFromNeighbors(neighbors: Neighbor[]): { score: number | null; meta: unknown | null } {
  if (!neighbors || neighbors.length === 0) return { score: null, meta: null };
  let weighted = 0;
  let absSum = 0;
  const metaNeighbors = neighbors.map((n) => {
    const sim = Number(n.similarity) || 0;
    const label = n.status === "rejected" ? -1 : 1; // approved/sent => +1
    weighted += sim * label;
    absSum += Math.abs(sim);
    return {
      id: n.id,
      title: n.edited_title || n.title,
      status: n.status,
      similarity: Math.round(sim * 100) / 100
    };
  });
  if (absSum === 0) return { score: null, meta: null };
  const score = Math.max(0, Math.min(100, Math.round(50 + 50 * (weighted / absSum))));
  return { score, meta: { neighbors: metaNeighbors, k: neighbors.length, version: 1 } };
}

// --- Few-shot block built from editor-rewritten neighbours ---
function buildFewShot(examples: Neighbor[]): string | null {
  if (!examples || examples.length === 0) return null;
  const blocks = examples.slice(0, 4).map((e) => {
    const lines: string[] = [];
    if (e.edited_title && e.edited_title !== e.title) {
      lines.push(`Headline rewrite:\n  BEFORE: ${e.title}\n  AFTER:  ${e.edited_title}`);
    }
    if (e.edited_summary && e.edited_summary !== e.summary) {
      lines.push(`Summary rewrite:\n  BEFORE: ${e.summary ?? ""}\n  AFTER:  ${e.edited_summary}`);
    }
    if (lines.length === 0) {
      lines.push(`Kept as-is: ${e.edited_title || e.title}`);
    }
    return lines.join("\n");
  });
  return `EDITORIAL STYLE MEMORY — the team recently reviewed similar stories and rewrote them as below. Match this house style: tone, length, phrasing, and what to cut. Do not copy the content; learn the style.\n\n${blocks.join("\n---\n")}`;
}

async function summarize(
  apiKey: string,
  model: string,
  article: Article,
  examples: Neighbor[] = [],
  guidance = ""
): Promise<{ summary: string; section: string; prominence: number }> {
  const userPrompt = [
    `PUBLISHED: ${(article.scraped_at ?? "").slice(0, 10) || "unknown"}`,
    `TITLE: ${article.title}`,
    article.source ? `SOURCE: ${article.source}` : null,
    `URL: ${article.url}`,
    article.raw_content ? `EXCERPT:\n${article.raw_content}` : null
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT }
  ];
  // Human editorial guidance from the AI Brain dashboard (highest-priority steer).
  if (guidance.trim()) {
    messages.push({ role: "system", content: `EDITOR GUIDANCE (follow this closely):\n${guidance.trim()}` });
  }
  const fewShot = buildFewShot(examples);
  if (fewShot) messages.push({ role: "system", content: fewShot });
  messages.push({ role: "user", content: userPrompt });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 350,
      messages
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
