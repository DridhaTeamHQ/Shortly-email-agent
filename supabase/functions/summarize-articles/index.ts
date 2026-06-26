// summarize-articles: take recent `pending` articles, summarize with GPT-4o,
// promote top 50 of the day to `summarized` (ready for QA review).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { cleanArticleText, fetchReadableArticleText, needsFullArticleFetch } from "../_shared/article-text.ts";
import { summarizeForBriefing } from "../_shared/summary-clean.ts";

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

  // Pull recent pending articles from the last 24 hours so QA has a deeper
  // General pool while still avoiding old articles in today's email workflow.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: pending, error } = await supabase
    .from("articles")
    .select("id,title,url,raw_content,source,rank_score,scraped_at")
    .eq("status", "pending")
    .gte("scraped_at", since)
    .order("rank_score", { ascending: false })
    .order("scraped_at", { ascending: false });

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
      const freshness = Math.max(0, 1 - ageHours / 24);
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

  // No demotion. Every article we summarize this run goes to `summarized` and STAYS
  // on the website for QA. Each run scrapes fresh headlines and summarizes the
  // batch of the highest-ranked ones; whatever isn't summarized simply ages out of the
  // 24h freshness window on the next run - it is never parked in a growing backlog and
  // never pulled back off the site. Editorial category briefs are inserted already
  // `summarized` by their own agents/triggers and are untouched here.

  const failed = results.filter((r) => !r.summary);
  return json({
    summarized: updates.length,
    failed: failed.length,
    failures: failed.slice(0, 5)
  });
});

async function summarize(apiKey: string, model: string, article: Article): Promise<{ summary: string; section: string; prominence: number }> {
  let excerpt = cleanArticleText(article.raw_content || "");

  if (excerpt.length < 180 && needsFullArticleFetch(article.raw_content || "")) {
    try {
      const readable = await fetchReadableArticleText(article.url);
      if (readable.length > excerpt.length) excerpt = readable;
    } catch {
      // Keep the cleaned RSS excerpt if page extraction fails.
    }
  }

  const result = await summarizeForBriefing(apiKey, model, {
    title: article.title,
    source: article.source,
    url: article.url,
    excerpt
  });
  if (!result.summary) throw new Error("empty summary after cleaning");
  return result;
}
