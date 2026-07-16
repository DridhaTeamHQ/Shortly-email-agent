// summarize-articles: summarize a small batch of the highest-ranked recent
// `pending` articles and promote them to `summarized` (ready for QA review).
// The batch is hard-capped (MAX_PER_RUN) so each run stays short — long runs
// hog the shared edge runtime and starve other dashboard calls (causing 502/CORS
// on list-articles), besides hitting the OpenAI rate limit.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { cleanArticleText, fetchReadableArticleText, needsFullArticleFetch } from "../_shared/article-text.ts";
import { summarizeForBriefing } from "../_shared/summary-clean.ts";
import { factCheckArticle, type FactCheckResult } from "../_shared/fact-check.ts";
import { findRelatedSources } from "../_shared/related-sources.ts";
import { embedTexts } from "../_shared/embeddings.ts";

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
  // General briefs run on gpt-4o-mini: the account's gpt-4o cap (~30k TPM) makes
  // batch summarization slow and 429-prone, which times out / starves the dashboard.
  // Mini has a far higher rate limit and is much faster; the long-form Corporate
  // Cases & topic features keep gpt-4o via their own functions. Override with
  // SUMMARIZE_MODEL if needed.
  const model = Deno.env.get("SUMMARIZE_MODEL") ?? "gpt-4o-mini";

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Pull recent pending articles from the last 24 hours, highest-ranked first.
  // HARD CAP per invocation: summarizing is the slow, rate-limited step (OpenAI
  // ~30k TPM), so we never process more than MAX_PER_RUN in one call — that keeps
  // the function comfortably inside the edge time budget and avoids 504s. Anything
  // beyond the cap is picked up on the next run or ages out of the 24h window.
  const MAX_PER_RUN = 40;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: pending, error } = await supabase
    .from("articles")
    .select("id,title,url,raw_content,source,rank_score,scraped_at")
    .eq("status", "pending")
    .gte("scraped_at", since)
    .order("rank_score", { ascending: false })
    .order("scraped_at", { ascending: false })
    .limit(MAX_PER_RUN);

  if (error) return json({ error: error.message }, 500);

  const articles = (pending ?? []) as Article[];
  if (articles.length === 0) return json({ summarized: 0, message: "No pending articles" });

  // Title embeddings for the whole batch in ONE call (effectively free) —
  // powers semantic same-story clustering for corroboration + breaking velocity.
  const vectors = await embedTexts(openAiKey, articles.map((a) => a.title));
  const embeddingById = new Map<string, number[]>();
  if (vectors) articles.forEach((a, i) => { if (vectors[i]) embeddingById.set(a.id, vectors[i]); });

  // Summarize in parallel (capped) to keep within edge time budget
  const CONCURRENCY = 4;
  const results: Array<{ id: string; summary: string | null; section: string; prominence: number; topic: string | null; fact: FactCheckResult | null; error?: string }> = [];

  for (let i = 0; i < articles.length; i += CONCURRENCY) {
    const batch = articles.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (a) => {
        try {
          const result = await summarize(supabase, openAiKey, model, a, embeddingById.get(a.id) ?? null);
          return { id: a.id, summary: result.summary, section: result.section, prominence: result.prominence, topic: result.topic, fact: result.fact };
        } catch (e) {
          return { id: a.id, summary: null, section: "wrapped", prominence: 2, topic: null, fact: null, error: String(e) };
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
      // Score = 35% source weight + 25% prominence + 20% freshness + 20% fact.
      // Folding the fact score in floats well-grounded articles to the top of the
      // review queue and the auto-select for email. Unscored articles get a
      // neutral 0.6 prior so a missing score neither helps nor buries them.
      const prominenceNorm = (r.prominence ?? 2) / 5;
      const factNorm = r.fact ? r.fact.fact_score / 100 : 0.6;
      const score = Number(a.rank_score ?? 0) * 0.35 + prominenceNorm * 0.25 + freshness * 0.2 + factNorm * 0.2;
      return {
        id: a.id,
        summary: r.summary!,
        section: r.section,
        prominence: r.prominence,
        rank_score: score,
        fact_score: r.fact?.fact_score ?? null,
        fact_label: r.fact?.fact_label ?? null,
        fact_notes: r.fact?.fact_notes ?? null,
        status: "summarized",
        summarized_at: new Date().toISOString()
      };
    });

  // Update in chunks
  for (const row of updates) {
    const embedding = embeddingById.get(row.id);
    const classified = results.find((r) => r.id === row.id)?.topic ?? null;
    await supabase.from("articles").update({
      summary: row.summary,
      section: row.section,
      prominence: row.prominence,
      // The classified SUBJECT topic (Sports/Business/…) replaces the feed tag —
      // a Messi story from an Indian paper's top-stories feed must read Sports,
      // not National. Feed tag stays when classification came back invalid.
      ...(classified ? { topic: classified } : {}),
      rank_score: row.rank_score,
      fact_score: row.fact_score,
      fact_label: row.fact_label,
      fact_notes: row.fact_notes,
      status: row.status,
      summarized_at: row.summarized_at,
      ...(embedding ? { title_embedding: embedding } : {})
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

async function summarize(supabase: any, apiKey: string, model: string, article: Article, embedding: number[] | null = null): Promise<{ summary: string; section: string; prominence: number; fact: FactCheckResult | null }> {
  let fullText = cleanArticleText(article.raw_content || "");

  // Fetch the readable article body when the RSS excerpt is thin. Raised the
  // trigger from 180 -> 700 chars: thin snippets were the main cause of
  // spuriously LOW fact scores — the fact-checker graded the summary against a
  // headline-length blurb, so genuinely-true claims read as "unsupported".
  // Fetching the real body gives it real evidence to confirm claims against.
  if (fullText.length < 700 && needsFullArticleFetch(article.raw_content || "")) {
    try {
      const readable = await fetchReadableArticleText(article.url);
      if (readable.length > fullText.length) fullText = readable;
    } catch {
      // Keep the cleaned RSS excerpt if page extraction fails.
    }
  }

  // Cap the SUMMARY excerpt so the prompt stays compact — a brief only needs the
  // lede, and smaller prompts keep a full run within the OpenAI rate budget.
  const summaryExcerpt = fullText.length > 1800 ? fullText.slice(0, 1800) : fullText;

  const result = await summarizeForBriefing(apiKey, model, {
    title: article.title,
    source: article.source,
    url: article.url,
    excerpt: summaryExcerpt
  });
  if (!result.summary) throw new Error("empty summary after cleaning");

  // Corroboration: other outlets in our scrape pool that ran the same story, so
  // the fact check can confirm claims across independent sources and record how
  // many. Never throws — falls back to single-source on any issue.
  const relatedSources = await findRelatedSources(supabase, {
    id: article.id, title: article.title, source: article.source, url: article.url, embedding
  });

  // Second cheap-model call: fact score. Grade against the FULLEST text we have
  // (fact-check.ts caps it) — never less than the summary saw, so more evidence
  // can only raise a legitimate score. Non-fatal: a null score never blocks the
  // article, and FACT_CHECK_ENABLED=false skips it entirely.
  const fact = await factCheckArticle(apiKey, {
    title: article.title,
    summary: result.summary,
    sourceText: fullText,
    primarySource: { source: article.source || "Source", url: article.url },
    relatedSources
  });
  return { ...result, fact };
}
