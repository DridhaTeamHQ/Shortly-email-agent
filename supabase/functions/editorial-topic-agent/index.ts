import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { Readability } from "npm:@mozilla/readability@0.6.0";
import { parseHTML } from "npm:linkedom@0.18.12";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { parseFeed } from "../_shared/rss.ts";
import { EDITORIAL_TOPICS, getEditorialTopic, type EditorialSource, type EditorialTopic } from "../_shared/editorial-topics.ts";
import { summarizeForBriefing } from "../_shared/summary-clean.ts";
import { matchesCategoryContent } from "../_shared/category-quality.ts";
import { factCheckArticle } from "../_shared/fact-check.ts";
import { findRelatedSources } from "../_shared/related-sources.ts";
import { buildCaseRow, indiaDateLabel, openAiJson } from "../_shared/editorial-case.ts";
import { requireAgent } from "../_shared/agent-auth.ts";

type Candidate = {
  title: string;
  url: string;
  excerpt: string;
  source: string;
  sourceWeight: number;
  publishedAt: string | null;
  compassOnly: boolean;
};

type RankedCandidate = {
  url: string;
  angle?: string;
  selection_reason?: string;
};

// Cost guardrails (2026-07-07). Short summaries run on the cheap model; case
// studies (the pricey gpt-4o calls) are capped at ONE per topic per run.
// Override via env if needed.
const MAX_SMALL_ARTICLE_CARDS_PER_RUN = Number(Deno.env.get("MAX_SMALL_ARTICLES") ?? "4");
const MAX_CASE_DRAFTS_PER_RUN = Number(Deno.env.get("MAX_CASE_DRAFTS") ?? "1");
// If unreviewed drafts pile up for a topic, skip its run entirely so we never
// spend on content nobody is approving. Approve/reject some to resume.
const EDITORIAL_BACKLOG_LIMIT = Number(Deno.env.get("EDITORIAL_BACKLOG_LIMIT") ?? "9");

async function handleRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Server-side auth: service_role JWT (cron) or the dashboard's agent token.
  const denied = await requireAgent(request);
  if (denied) return denied;

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const url = new URL(request.url);

  if (request.method === "GET") {
    const topic = url.searchParams.get("topic");
    let query = supabase.from("editorial_drafts").select("*").order("generated_at", { ascending: false }).limit(200);
    if (topic) query = query.eq("topic_slug", topic);
    const { data, error } = await query;
    if (error) return json({ error: error.message }, 500);
    return json({ topics: Object.values(EDITORIAL_TOPICS).map(topicMeta), drafts: data ?? [] });
  }

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await request.json().catch(() => ({}));

  if (["update", "approve", "reject"].includes(String(body.action ?? ""))) {
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id is required" }, 400);
    const { data: current, error: currentError } = await supabase
      .from("editorial_drafts")
      .select("*")
      .eq("id", id)
      .single();
    if (currentError) return json({ error: currentError.message }, 500);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.action === "approve") patch.status = "approved";
    if (body.action === "reject") patch.status = "rejected";
    if (body.action === "update") {
      const content = { ...(current.content ?? {}) };
      const cardType = String(body.card_type ?? "single");
      // Legacy hybrid rows may still exist in the table; preserve the ability to
      // edit their briefs. New rows are always format:'single'.
      if (current.format === "hybrid" && cardType === "brief") {
        const index = Number(body.brief_index);
        const briefs = Array.isArray(content.briefs) ? [...content.briefs] : [];
        if (!Number.isInteger(index) || !briefs[index]) return json({ error: "valid brief_index is required" }, 400);
        briefs[index] = {
          ...briefs[index],
          headline: String(body.headline ?? briefs[index].headline ?? "").trim(),
          what_happened: String(body.what_happened ?? briefs[index].what_happened ?? "").trim(),
          why_it_matters: String(body.why_it_matters ?? briefs[index].why_it_matters ?? "").trim()
        };
        content.briefs = briefs;
        patch.briefing_items = briefs;
      } else {
        const target = current.format === "hybrid"
          ? { ...(content.feature ?? {}) }
          : content;
        target.headline = String(body.headline ?? target.headline ?? current.headline ?? "").trim();
        target.summary = String(body.summary ?? target.summary ?? current.summary ?? "").trim();
        target.detail = String(body.detail ?? target.detail ?? current.detail ?? "").trim();
        if (current.format === "hybrid") content.feature = target;
        else Object.assign(content, target);
        patch.headline = target.headline;
        patch.summary = target.summary;
        patch.detail = target.detail;
      }
      patch.content = content;
    }

    const { data, error } = await supabase
      .from("editorial_drafts")
      .update(patch)
      .eq("id", id)
      .select("*")
      .single();
    if (error) return json({ error: error.message }, 500);

    // On approve, enrich the long read for the website in the background:
    // fact score (graded against the refetched primary source) + alternate
    // reader versions. Never blocks or fails the approval itself.
    if (body.action === "approve" && data) {
      const task = enrichApprovedDraft(supabase, data);
      const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (runtime?.waitUntil) runtime.waitUntil(task);
      else await task;
    }

    return json({ draft: data });
  }

  const topic = getEditorialTopic(String(body.topic ?? ""));
  if (!topic) return json({ error: "Unknown topic", allowed: Object.keys(EDITORIAL_TOPICS) }, 400);

  // Cost guardrail: skip the whole (OpenAI-spending) run when unreviewed drafts
  // are stacking up for this topic. Manual `force:true` bypasses it.
  if (body.force !== true) {
    const { count: backlog } = await supabase
      .from("editorial_drafts")
      .select("id", { count: "exact", head: true })
      .eq("topic_slug", topic.slug)
      .eq("status", "draft");
    if ((backlog ?? 0) >= EDITORIAL_BACKLOG_LIMIT) {
      return json({
        skipped: true,
        reason: `Backlog guard: ${backlog} unreviewed ${topic.name} drafts (limit ${EDITORIAL_BACKLOG_LIMIT}). Approve or reject some to resume, or POST {force:true}.`,
      });
    }
  }

  const sourceErrors: Array<{ source: string; error: string }> = [];
  const candidates = await collectCandidates(topic, sourceErrors);
  // Cited candidates only (Reddit is compass-only and never a case-study source).
  const citedCandidates = candidates
    .filter((item) => !item.compassOnly)
    .filter((item) => topic.slug !== "real-estate" || matchesCategoryContent(topic.name, item.title, item.excerpt));
  if (citedCandidates.length === 0) {
    return json({ error: "No usable cited candidates were found for this topic.", sourceErrors }, 422);
  }

  const openAiKey = requiredEnv("OPENAI_API_KEY");
  // Flagship case-study drafts + ranking. Moved off gpt-4o -> gpt-4.1-mini
  // (2026-07-10): ~6x cheaper ($0.40/$1.60 vs $2.50/$10 per 1M) and strong
  // enough at this constrained, structured writing task, with the repair pass
  // as a safety net. gpt-4o was the top tier when built, before 4.1-mini
  // existed. Override with the OPENAI_MODEL secret. Short summaries stay on the
  // cheapest capable model.
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";
  const shortModel = Deno.env.get("SUMMARIZE_MODEL") ?? "gpt-4o-mini";
  // Ranking just picks the best candidate URLs from a list — the cheapest
  // capable model handles it fine ($0.10/$0.40 vs the case-writer's tier).
  const rankModel = Deno.env.get("RANK_MODEL") ?? "gpt-4.1-nano";

  // Short-article generation into the articles table (category = topic name).
  const sourceArticleUrls = await upsertSourceCandidateArticles(supabase, topic, citedCandidates, openAiKey, shortModel);
  const shortArticlesInserted = await countArticlesByUrl(supabase, sourceArticleUrls);

  // Dedup vs recent editorial_drafts primary sources (last 30 days) so each run
  // produces genuinely NEW case studies.
  const recentSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await supabase
    .from("editorial_drafts")
    .select("primary_source_url")
    .eq("topic_slug", topic.slug)
    .gte("generated_at", recentSince);
  const recentUrls = new Set((recent ?? []).map((row: any) => row.primary_source_url as string));
  const freshCandidates = citedCandidates.filter((candidate) => !recentUrls.has(candidate.url));
  const selectionPool = freshCandidates.length > 0 ? freshCandidates : citedCandidates;

  // Rank/select the strongest candidates for this topic.
  const ranked = await rankCandidates(openAiKey, rankModel, topic, selectionPool);
  const candidatesByUrl = new Map(selectionPool.map((candidate) => [candidate.url, candidate]));
  const rankedUrls = ranked
    .map((item) => item.url)
    .filter((rankedUrl) => candidatesByUrl.has(rankedUrl));
  // If the ranker returned nothing usable, fall back to the freshest pool order.
  const orderedUrls = rankedUrls.length > 0
    ? [...new Set(rankedUrls)]
    : selectionPool.map((candidate) => candidate.url);

  const drafts: Array<Record<string, unknown>> = [];
  const failures: Array<{ url: string; error: string }> = [];

  // Persist each draft AS SOON AS it is written. With up to
  // MAX_CASE_DRAFTS_PER_RUN drafts a run can push several minutes; a batch
  // insert at the end would lose EVERY finished draft (after paying for the
  // model calls) if the run hits the edge time budget mid-way.
  const insertDraft = async (row: Record<string, unknown>) => {
    const { data, error } = await supabase.from("editorial_drafts").insert(row).select("*").single();
    if (error) throw new Error(error.message);
    drafts.push(data);
  };

  // Write UP TO MAX_CASE_DRAFTS_PER_RUN single case studies under the full bar.
  for (const candidateUrl of orderedUrls) {
    if (drafts.length >= MAX_CASE_DRAFTS_PER_RUN) break;
    const candidate = candidatesByUrl.get(candidateUrl);
    if (!candidate) continue;
    const articleText = await fetchPublicArticleText(candidate.url).catch((error) => {
      failures.push({ url: candidate.url, error: String(error) });
      return "";
    });
    const usableText = articleText.length >= 1800 ? articleText : candidate.excerpt;
    if (usableText.length < 700) {
      failures.push({ url: candidate.url, error: "Not enough public source text" });
      continue;
    }
    const selectionMeta = ranked.find((item) => item.url === candidateUrl) ?? { url: candidateUrl };
    try {
      const row = await buildCaseRow(openAiKey, model, topic, candidate, usableText, selectionMeta);
      await insertDraft(row);
    } catch (error) {
      failures.push({ url: candidate.url, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // NEVER EMPTY: if nothing cleared the full bar, write at least one case study
  // from the best available candidate under a relaxed (but still strictly
  // source-bound) structure bar, so every run produces something.
  if (drafts.length === 0) {
    const fallbackPool = selectionPool.length > 0 ? selectionPool : citedCandidates;
    for (const candidate of fallbackPool.slice(0, 5)) {
      const articleText = await fetchPublicArticleText(candidate.url).catch(() => "");
      const usableText = articleText.length >= 800 ? articleText : candidate.excerpt;
      if (usableText.length < 300) continue;
      const selectionMeta = ranked.find((item) => item.url === candidate.url) ?? { url: candidate.url };
      try {
        await insertDraft(await buildCaseRow(openAiKey, model, topic, candidate, usableText, selectionMeta, true));
        break;
      } catch (error) {
        failures.push({ url: candidate.url, error: "fallback: " + (error instanceof Error ? error.message : String(error)) });
      }
    }
  }

  if (drafts.length === 0) {
    return json({
      error: "Candidates were found, but none exposed enough public source text for a source-bound case study.",
      scanned: selectionPool.length,
      shortArticlesInserted,
      sourceErrors,
      failures: failures.slice(0, 10)
    }, 422);
  }

  return json({
    drafts,
    inserted: drafts.length,
    shortArticlesInserted,
    scanned: candidates.length,
    freshCandidates: freshCandidates.length,
    sourceErrors,
    failures: failures.slice(0, 10)
  });
}

Deno.serve(async (request) => {
  try {
    return await handleRequest(request);
  } catch (error) {
    console.error(error);
    return json({ error: String(error) }, 500);
  }
});

function topicMeta(topic: EditorialTopic) {
  return { slug: topic.slug, name: topic.name, format: topic.format, cadence: topic.cadence, description: topic.description };
}

// Post-approval enrichment for a long read: fact score only. Alternate reader
// versions (ELI5 / TL;DR / deep dive / key numbers) are GENERAL-category only,
// so long reads (always a topic category) do not get them. The fact check
// grades the published detail against the primary source refetched now (drafts
// don't store source text). Optional — a failure just leaves the score null.
async function enrichApprovedDraft(supabase: any, draft: any): Promise<void> {
  try {
    if (draft.fact_score != null) return; // already scored on a prior approve
    const openAiKey = requiredEnv("OPENAI_API_KEY");
    const headline = String(draft.headline || "");
    const detail = String(draft.detail || draft.summary || "");
    if (!headline || !detail || !draft.primary_source_url) return;

    const sourceText = await fetchPublicArticleText(String(draft.primary_source_url)).catch(() => "");
    if (!sourceText) return;

    const fact = await factCheckArticle(openAiKey, { title: headline, summary: detail, sourceText });
    if (fact) {
      await supabase.from("editorial_drafts").update({
        fact_score: fact.fact_score,
        fact_label: fact.fact_label,
        fact_notes: fact.fact_notes,
      }).eq("id", draft.id);
    }
  } catch {
    // Non-fatal by design.
  }
}

// Topic names now double as the articles.category value ("Real Estate",
// "Automobile", "Health & Wellness", "Tech & AI", "Markets & Startups").
function shortArticleCategory(topic: EditorialTopic): string {
  return topic.name;
}

async function upsertSourceCandidateArticles(
  supabase: any,
  topic: EditorialTopic,
  candidates: Candidate[],
  openAiKey: string,
  model: string
): Promise<string[]> {
  const category = shortArticleCategory(topic);
  // Skip URLs we already have for this category so each run summarizes genuinely
  // NEW short articles, instead of re-doing the same recent few every time.
  const recentSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: existingRows } = await supabase
    .from("articles")
    .select("url")
    .eq("category", category)
    .gte("scraped_at", recentSince)
    .limit(5000);
  const existingUrls = new Set((existingRows ?? []).map((r: any) => r.url as string));
  const eligibleCandidates = candidates
    .filter((candidate) => isEligibleSmallArticleSource(topic, candidate))
    .filter((candidate) => !existingUrls.has(candidate.url))
    .slice(0, MAX_SMALL_ARTICLE_CARDS_PER_RUN);
  const rows = await mapWithConcurrency(eligibleCandidates, 1, async (candidate) => {
    const articleText = await fetchPublicArticleText(candidate.url).catch(() => "");
    const rawContent = articleText.length >= 500 ? articleText : candidate.excerpt;
    // Professional news-writer summary via GPT (not a raw excerpt slice).
    let summary = "";
    let section: "wrapped" | "ahead" = "wrapped";
    let prominence = 2;
    try {
      const result = await summarizeForBriefing(openAiKey, model, {
        title: candidate.title, source: candidate.source, url: candidate.url, excerpt: rawContent
      });
      summary = result.summary; section = result.section; prominence = result.prominence;
    } catch {
      return null; // skip rather than ship a raw excerpt
    }
    if (!summary || !isGoodSmallArticleCandidate(topic, candidate, rawContent, summary)) return null;
    // AI fact score against the scraped source text, corroborated across other
    // outlets in our pool that ran the same story; null (unscored) on failure.
    const relatedSources = await findRelatedSources(supabase, {
      title: candidate.title, source: candidate.source, url: candidate.url
    });
    const fact = await factCheckArticle(openAiKey, {
      title: candidate.title, summary, sourceText: rawContent,
      primarySource: { source: candidate.source || "Source", url: candidate.url },
      relatedSources
    });
    return {
      title: candidate.title.trim().slice(0, 500),
      url: candidate.url,
      raw_content: rawContent.slice(0, 12000),
      summary,
      source: candidate.source,
      topic: category,
      category,
      section,
      status: "summarized",
      prominence,
      // Weight the source rank by grounding: a well-fact-checked article ranks
      // up to ~30% higher, a poorly-grounded one up to ~30% lower. Unscored
      // articles (fact === null) keep their plain source weight.
      rank_score: candidate.sourceWeight * (fact ? 0.7 + 0.6 * (fact.fact_score / 100) : 1),
      fact_score: fact?.fact_score ?? null,
      fact_label: fact?.fact_label ?? null,
      fact_notes: fact?.fact_notes ?? null,
      // scraped_at must be the SCRAPE time, not the RSS publish date: the
      // dashboard and list-articles only show today's (IST) scraped_at window,
      // so backdating to publishedAt makes fresh scrapes invisible.
      scraped_at: new Date().toISOString(),
      summarized_at: new Date().toISOString()
    };
  });
  const validRows = rows
    .filter((row): row is NonNullable<typeof row> => Boolean(row?.title && row.url && row.summary));
  if (validRows.length === 0) return [];
  const { error } = await supabase
    .from("articles")
    .upsert(validRows, { onConflict: "url", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  return validRows.map((row) => row.url);
}

function isGoodSmallArticleCandidate(topic: EditorialTopic, candidate: Candidate, rawContent: string, summary: string): boolean {
  if (candidate.compassOnly) return false;
  if (!isEligibleSmallArticleSource(topic, candidate)) return false;
  const title = candidate.title.toLowerCase();
  const url = candidate.url.toLowerCase();
  const blockedTitle = /\b(note of gratitude|obituary|tribute|vacancy|recruitment|tender|invites applications?|phone number|contact us|newsletter|podcast|webinar|event|press release|notification no\.?|circular no\.?)\b/i;
  if (blockedTitle.test(title)) return false;
  if (/\.(pdf|doc|docx|xls|xlsx)(\?|$)/i.test(url)) return false;
  const wordCount = String(summary || rawContent || "").split(/\s+/).filter(Boolean).length;
  if (wordCount < 45) return false;
  if (rawContent.length < 500 && candidate.excerpt.length < 350) return false;
  // Topic-relevance gate for EVERY topic: a polluted or misconfigured feed
  // (e.g. a cricket feed mislabelled as real estate) must never push off-topic
  // stories into a category pool. The candidate's title+summary has to carry at
  // least one on-topic term.
  const haystack = `${title} ${summary}`;
  const relevance = TOPIC_RELEVANCE[topic.slug];
  if (relevance && !relevance.test(haystack)) return false;
  if (topic.slug === "real-estate" && !matchesCategoryContent(topic.name, title, `${summary} ${rawContent}`)) return false;
  return true;
}

// On-topic vocabularies per category — deliberately broad (any single hit
// passes); their job is to reject obviously foreign stories (sports, cinema,
// crime blotter) rather than to precisely classify.
const TOPIC_RELEVANCE: Record<string, RegExp> = {
  "real-estate": /\b(real estate|realty|property|properties|housing|home\s?buyers?|house prices?|apartment|flat|villa|builder|developer|rera|land|plot|township|residential|commercial|office space|mall|warehous|rent|rental|lease|tenant|landlord|sq ?ft|square feet|acre|home sales?|home loan|affordable housing|redevelopment|construction|infrastructur)\b/i,
  "automobile": /\b(car|cars|suv|sedan|hatchback|bike|motorcycle|scooter|two-wheeler|vehicle|automobile|automotive|auto industry|ev|electric vehicle|hybrid|charging|battery|mileage|engine|launch(ed|es)?|facelift|recall|dealership|maruti|tata motors|mahindra|hyundai|kia|toyota|honda|bajaj|hero|ola electric|ather|royal enfield|mg motor|skoda|volkswagen|bmw|mercedes|audi|nexon|creta|swift|fame|pli|bharat ncap|gncap|emission|traffic|highway)\b/i,
  "health-wellness": /\b(health|wellness|fitness|exercise|workout|yoga|diet|nutrition|food|protein|vitamin|sleep|insomnia|mental health|anxiety|depression|stress|burnout|therapy|doctor|hospital|disease|condition|diagnos\w*|diabetes|hypertension|obesity|heart|cancer|immunity|gut|hormone|fertility|pregnan\w*|surgery|kidney|liver|drug|medicine|study|research|screen time|habit|meditation|mindfulness|walking|running|gym|posture|hydration|alcohol|smoking|vaccin)\b/i,
  "tech-ai": /\b(ai|artificial intelligence|machine learning|llm|chatgpt|openai|gemini|anthropic|model|algorithm|tech|technology|software|hardware|app|apps|smartphone|laptop|chip|semiconductor|gpu|data|cloud|cyber|hack|breach|privacy|dpdp|it rules|startup|platform|google|microsoft|apple|meta|amazon|nvidia|infosys|tcs|wipro|digital|internet|social media|whatsapp|instagram|coding|developer|robot|automation|5g|6g|satellite|spacex|isro)\b/i,
  "markets-startups": /\b(money|tax|rbi|sebi|bank|mutual fund|insurance|loan|credit|debit|upi|invest|income|finance|market|stock|ipo|savings?|pension|fraud|scam|startup|funding|valuation|venture|unicorn|acquisition|merger|listing)\b/i,
};

function isEligibleSmallArticleSource(topic: EditorialTopic, candidate: Candidate): boolean {
  if (candidate.compassOnly) return false;
  if (topic.slug === "markets-startups") {
    return new Set([
      "Mint Money", "Mint Markets", "Moneycontrol", "BusinessLine Markets", "BusinessLine Banking",
      "ET Markets", "ET Wealth", "Inc42", "Entrackr", "YourStory",
      "ET Startups", "ET Economy", "BusinessLine Economy", "Mint Companies", "NDTV Profit"
    ]).has(candidate.source);
  }
  return true;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const mapped = await Promise.all(batch.map((item, offset) => mapper(item, i + offset)));
    results.push(...mapped);
  }
  return results;
}

async function countArticlesByUrl(supabase: any, urls: string[]): Promise<number> {
  if (urls.length === 0) return 0;
  const { data, error } = await supabase
    .from("articles")
    .select("id")
    .in("url", urls);
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

async function collectCandidates(topic: EditorialTopic, sourceErrors: Array<{ source: string; error: string }>): Promise<Candidate[]> {
  const cutoff = Date.now() - 5 * 24 * 60 * 60 * 1000;
  const output: Candidate[] = [];
  await Promise.all(topic.sources.map(async (source) => {
    try {
      const items = source.kind === "reddit"
        ? await fetchReddit(source)
        : source.kind === "html"
          ? await fetchHtmlListing(source)
          : await fetchFeed(source);
      for (const item of items) {
        if (source.accepts && !source.accepts(item.url)) continue;
        const published = item.publishedAt ? new Date(item.publishedAt) : null;
        if (published && !Number.isNaN(published.getTime()) && published.getTime() < cutoff) continue;
        output.push({
          ...item,
          excerpt: item.excerpt.slice(0, 1800),
          source: source.name,
          sourceWeight: source.weight,
          publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null,
          compassOnly: source.kind === "reddit"
        });
      }
    } catch (error) {
      sourceErrors.push({ source: source.name, error: String(error) });
    }
  }));
  const unique = new Map<string, Candidate>();
  for (const item of output) unique.set(item.url, item);
  return [...unique.values()].sort((a, b) => {
    const aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return (bTime - aTime) || (b.sourceWeight - a.sourceWeight);
  });
}

async function fetchFeed(source: EditorialSource) {
  const response = await fetch(source.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ShortlyEditorial/1.0)" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseFeed(await response.text()).map((item) => ({
    title: item.title,
    url: item.url,
    excerpt: item.description,
    publishedAt: item.publishedAt
  }));
}

async function fetchReddit(source: EditorialSource) {
  const response = await fetch(source.url, { headers: { "User-Agent": "ShortlyEditorial/1.0 by Shortly" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return (payload?.data?.children ?? []).map((entry: any) => ({
    title: String(entry?.data?.title ?? ""),
    url: `https://www.reddit.com${entry?.data?.permalink ?? ""}`,
    excerpt: String(entry?.data?.selftext ?? ""),
    publishedAt: entry?.data?.created_utc ? new Date(entry.data.created_utc * 1000).toISOString() : null
  })).filter((item: any) => item.title && item.url);
}

async function fetchHtmlListing(source: EditorialSource) {
  const response = await fetch(source.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ShortlyEditorial/1.0)" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { document } = parseHTML(await response.text());
  const items: Array<{ title: string; url: string; excerpt: string; publishedAt: string | null }> = [];
  for (const anchor of [...document.querySelectorAll("a[href]")]) {
    const title = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
    if (title.length < 28 || title.length > 220) continue;
    let url = "";
    try {
      url = new URL(anchor.getAttribute("href") ?? "", source.url).toString().split("#")[0];
    } catch {
      continue;
    }
    if (!/^https?:/.test(url) || url === source.url) continue;
    items.push({ title, url, excerpt: title, publishedAt: null });
  }
  const unique = new Map(items.map((item) => [item.url, item]));
  return [...unique.values()].slice(0, 40);
}

async function rankCandidates(apiKey: string, model: string, topic: EditorialTopic, candidates: Candidate[]): Promise<RankedCandidate[]> {
  const compact = candidates.slice(0, 60).map((item) => ({
    title: item.title,
    url: item.url,
    source: item.source,
    published_at: item.publishedAt,
    excerpt: item.excerpt.slice(0, 650)
  }));

  const prompt = `Rank the strongest ${topic.name} candidates for standalone case-study articles.

INDIA DATE: ${indiaDateLabel()}

Each selected candidate becomes ITS OWN single case study (one headline, one summary, one detailed analysis), so pick stories that individually carry enough substance for a 300-500 word analytical piece.

TOPIC FOCUS: ${topic.description}
SELECTION: ${topic.selection}

Selection order:
1. A specific, interesting development with real substance (named actors, numbers, decisions, or concrete facts).
2. Prefer the last 24-48 hours, but use up to five days if stronger.
3. Prefer a useful spread of distinct stories rather than several versions of the same news.
4. Each article must stand on its own; skip thin listicles, pure opinion with no facts, and stock tips.

Return JSON only:
{"ranked":[{"url":"exact candidate URL","angle":"the specific angle for a case study","selection_reason":"one sentence"}]}

Return up to ${MAX_CASE_DRAFTS_PER_RUN + 3} candidates, strongest first. Use only URLs supplied below.

CANDIDATES:
${JSON.stringify(compact)}`;
  const parsed = await openAiJson(apiKey, model, `You are a rigorous Indian ${topic.name} assignment editor selecting source-backed case studies.`, prompt, 1400);
  return Array.isArray(parsed.ranked) ? parsed.ranked : [];
}

async function fetchPublicArticleText(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; ShortlyEditorial/1.0)" } });
  if (!response.ok) throw new Error(`Article HTTP ${response.status}`);
  const { document } = parseHTML(await response.text());
  const parsed = new Readability(document as unknown as Document).parse();
  return (parsed?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 18000);
}
