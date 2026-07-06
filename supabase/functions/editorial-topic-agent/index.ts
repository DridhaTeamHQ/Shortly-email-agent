import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { Readability } from "npm:@mozilla/readability@0.6.0";
import { parseHTML } from "npm:linkedom@0.18.12";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { parseFeed } from "../_shared/rss.ts";
import { EDITORIAL_TOPICS, getEditorialTopic, type EditorialSource, type EditorialTopic } from "../_shared/editorial-topics.ts";
import { summarizeForBriefing, chatCompletionRaw } from "../_shared/summary-clean.ts";

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

// Keep a 20-50 item review pool without flooding the downstream send step.
const MAX_SMALL_ARTICLE_CARDS_PER_RUN = 25;
// Target up to 5 case-study drafts per topic run for a useful QA pool.
const MAX_CASE_DRAFTS_PER_RUN = 5;

async function handleRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
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
    return json({ draft: data });
  }

  const topic = getEditorialTopic(String(body.topic ?? ""));
  if (!topic) return json({ error: "Unknown topic", allowed: Object.keys(EDITORIAL_TOPICS) }, 400);

  const sourceErrors: Array<{ source: string; error: string }> = [];
  const candidates = await collectCandidates(topic, sourceErrors);
  // Cited candidates only (Reddit is compass-only and never a case-study source).
  const citedCandidates = candidates.filter((item) => !item.compassOnly);
  if (citedCandidates.length === 0) {
    return json({ error: "No usable cited candidates were found for this topic.", sourceErrors }, 422);
  }

  const openAiKey = requiredEnv("OPENAI_API_KEY");
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";

  // Short-article generation into the articles table (category = topic name).
  const sourceArticleUrls = await upsertSourceCandidateArticles(supabase, topic, citedCandidates, openAiKey, model);
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
  const ranked = await rankCandidates(openAiKey, model, topic, selectionPool);
  const candidatesByUrl = new Map(selectionPool.map((candidate) => [candidate.url, candidate]));
  const rankedUrls = ranked
    .map((item) => item.url)
    .filter((rankedUrl) => candidatesByUrl.has(rankedUrl));
  // If the ranker returned nothing usable, fall back to the freshest pool order.
  const orderedUrls = rankedUrls.length > 0
    ? [...new Set(rankedUrls)]
    : selectionPool.map((candidate) => candidate.url);

  const rows: Array<Record<string, unknown>> = [];
  const failures: Array<{ url: string; error: string }> = [];

  // Write UP TO MAX_CASE_DRAFTS_PER_RUN single case studies under the full bar.
  for (const candidateUrl of orderedUrls) {
    if (rows.length >= MAX_CASE_DRAFTS_PER_RUN) break;
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
      rows.push(row);
    } catch (error) {
      failures.push({ url: candidate.url, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // NEVER EMPTY: if nothing cleared the full bar, write at least one case study
  // from the best available candidate under a relaxed (but still strictly
  // source-bound) structure bar, so every run produces something.
  if (rows.length === 0) {
    const fallbackPool = selectionPool.length > 0 ? selectionPool : citedCandidates;
    for (const candidate of fallbackPool.slice(0, 5)) {
      const articleText = await fetchPublicArticleText(candidate.url).catch(() => "");
      const usableText = articleText.length >= 800 ? articleText : candidate.excerpt;
      if (usableText.length < 300) continue;
      const selectionMeta = ranked.find((item) => item.url === candidate.url) ?? { url: candidate.url };
      try {
        rows.push(await buildCaseRow(openAiKey, model, topic, candidate, usableText, selectionMeta, true));
        break;
      } catch (error) {
        failures.push({ url: candidate.url, error: "fallback: " + (error instanceof Error ? error.message : String(error)) });
      }
    }
  }

  if (rows.length === 0) {
    return json({
      error: "Candidates were found, but none exposed enough public source text for a source-bound case study.",
      scanned: selectionPool.length,
      shortArticlesInserted,
      sourceErrors,
      failures: failures.slice(0, 10)
    }, 422);
  }

  const { data, error } = await supabase
    .from("editorial_drafts")
    .insert(rows)
    .select("*");
  if (error) return json({ error: error.message }, 500);

  return json({
    drafts: data ?? [],
    inserted: data?.length ?? 0,
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

async function buildCaseRow(
  apiKey: string,
  model: string,
  topic: EditorialTopic,
  candidate: Candidate,
  sourceText: string,
  selectionMeta: RankedCandidate,
  relaxed = false
): Promise<Record<string, unknown>> {
  let draft = await writeCase(apiKey, model, topic, candidate, sourceText, selectionMeta);
  draft = enforceSafety(topic, draft);
  if (!draftMeetsStructure(topic, draft)) {
    draft = enforceSafety(topic, await repairCase(apiKey, model, topic, candidate, sourceText, selectionMeta, draft));
  }
  // Normal runs enforce the full structure; the never-empty fallback accepts a
  // shorter, still source-bound draft so a run never yields zero case studies.
  if (relaxed ? !draftMeetsRelaxed(topic, draft) : !draftMeetsStructure(topic, draft)) {
    throw new Error(`Generated case failed structure for ${candidate.title}: summary_words=${words(draft.summary)}, detail_words=${words(draft.detail)}`);
  }

  const headline = String(draft.headline ?? candidate.title ?? "").trim() || candidate.title;
  const summary = String(draft.summary ?? "").trim();
  const detail = String(draft.detail ?? "").trim();
  const inferenceNotes = Array.isArray(draft.inference_notes) ? draft.inference_notes : [];

  const content: Record<string, unknown> = {
    headline,
    summary,
    detail,
    source_url: candidate.url,
    inference_notes: inferenceNotes,
    selection_reason: String(selectionMeta.selection_reason ?? draft.selection_reason ?? "").trim() || null,
    angle: String(selectionMeta.angle ?? draft.angle ?? "").trim() || null
  };

  const sourceLinks = [{ title: candidate.title, source: candidate.source, url: candidate.url }];

  return {
    topic_slug: topic.slug,
    topic_name: topic.name,
    format: "single",
    headline,
    summary,
    detail,
    briefing_items: [],
    content,
    source_links: sourceLinks,
    primary_source_url: candidate.url,
    primary_source_title: candidate.title,
    editor_checklist: topic.checklist,
    inference_notes: inferenceNotes,
    status: "draft",
    generated_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

function topicMeta(topic: EditorialTopic) {
  return { slug: topic.slug, name: topic.name, format: topic.format, cadence: topic.cadence, description: topic.description };
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
      rank_score: candidate.sourceWeight,
      scraped_at: candidate.publishedAt ?? new Date().toISOString(),
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
  if (topic.slug === "markets-startups") {
    return /\b(money|tax|rbi|sebi|bank|mutual fund|insurance|loan|credit|debit|upi|invest|income|finance|market|stock|ipo|savings?|pension|fraud|scam|startup|funding|valuation|venture|unicorn|acquisition|merger|listing)\b/i.test(`${title} ${summary}`);
  }
  return true;
}

function isEligibleSmallArticleSource(topic: EditorialTopic, candidate: Candidate): boolean {
  if (candidate.compassOnly) return false;
  if (topic.slug === "markets-startups") {
    return new Set([
      "Mint Money", "Mint Markets", "Moneycontrol", "BusinessLine Markets", "BusinessLine Banking",
      "ET Markets", "ET Wealth", "Inc42", "Entrackr", "YourStory"
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

async function writeCase(
  apiKey: string,
  model: string,
  topic: EditorialTopic,
  candidate: Candidate,
  sourceText: string,
  selection: RankedCandidate
): Promise<Record<string, any>> {
  const prompt = `Draft a single ${topic.name} case study for a human editor, using ONLY the source material below.

INDIA DATE: ${indiaDateLabel()}

VIBE: ${topic.description}
SELECTION FRAME: ${topic.selection}
VOICE: ${topic.voice}
SAFETY: ${topic.safety}

Required structure:
- headline: precise and specific to this story, framed for ${topic.name}.
- summary: 90-130 words. State what happened and why it matters, complete on its own. Do NOT open the detail by restating the summary.
- detail: 300-500 words of fresh, ${topic.name}-framed analysis. Open on the core dynamic or stake, not a restatement of the summary. Do NOT write a source-credit sentence ("according to", "the article reports"), do NOT include the source URL or a "read the full piece" line — the source link is shown separately by the app. Attribute the source publication naturally in prose only where needed. Cover mechanism/context, what mainstream coverage may miss, a concrete example or comparison, and what a reader should watch.
- inference_notes: array of every analogy, extrapolation, comparison, or unsourced translation the editor must verify.

Hard rules:
- Every factual claim and every number must come from the supplied source text. Do not use latent knowledge for facts or numbers.
- Do not invent Indian salary, price, rent, EMI, yield, health, tax, return or policy numbers. If the source does not provide a number, say so or leave it out.
- Paraphrase. At most one source quote, under 15 words. Prefer no direct quote.
- Define jargon the first time it appears.
- No exclamation marks, no marketing or press-release language.
- Respect the topic VOICE and SAFETY lines above exactly.

Return JSON only with these keys:
{"headline":"","summary":"","detail":"","angle":"","selection_reason":"","inference_notes":[]}

SOURCE PUBLICATION: ${candidate.source}
SOURCE TITLE: ${candidate.title}
SOURCE URL: ${candidate.url}
SELECTION CONTEXT: ${selection.angle ?? selection.selection_reason ?? ""}

SOURCE TEXT:
${sourceText.slice(0, 18000)}`;

  return await openAiJson(apiKey, model, `You are the final source-bound drafting voice for ${topic.name}. Be analytical, skeptical, source-bound, and concise.`, prompt, 2600);
}

async function repairCase(
  apiKey: string,
  model: string,
  topic: EditorialTopic,
  candidate: Candidate,
  sourceText: string,
  selection: RankedCandidate,
  draft: Record<string, any>
): Promise<Record<string, any>> {
  const prompt = `Repair this ${topic.name} case-study draft so it follows the required structure exactly.

Requirements:
- summary: 90-130 words, complete on its own.
- detail: 300-500 words of ${topic.name}-framed analysis.
- Use only facts and numbers present in the source text; do not invent Indian numbers.
- The detail must not restate the summary's opening, must not include any source-credit sentence, "read the full piece" line, or the source URL (the source link is shown separately by the app).
- Flag every analogy/extrapolation in inference_notes.
- Respect the topic voice and safety rules: ${topic.safety}
- No exclamation marks, no marketing language.

Return the same JSON keys as the current draft and no extra text.

VALIDATION FAILURES: ${JSON.stringify(validationReport(topic, draft))}

SOURCE PUBLICATION: ${candidate.source}
SOURCE TITLE: ${candidate.title}
SOURCE URL: ${candidate.url}
SELECTION CONTEXT: ${selection.angle ?? selection.selection_reason ?? ""}

CURRENT DRAFT:
${JSON.stringify(draft)}

SOURCE TEXT:
${sourceText.slice(0, 18000)}`;
  return await openAiJson(apiKey, model, `You are a strict source-bound editor repairing a ${topic.name} case-study draft.`, prompt, 2800);
}

function enforceSafety(topic: EditorialTopic, draft: Record<string, any>): Record<string, any> {
  if (!draft) return draft;
  let detail = String(draft.detail ?? "").trim();
  if (topic.slug === "markets-startups") {
    const disclaimer = "This isn't investment advice. We don't know your situation. Talk to a SEBI-registered advisor before acting on anything you read here.";
    detail = detail.replaceAll(disclaimer, "").trim();
    detail = detail ? `${detail}\n\n${disclaimer}` : disclaimer;
  }
  if (topic.slug === "health-wellness") {
    const combined = `${draft.headline ?? ""} ${draft.summary ?? ""} ${detail}`.toLowerCase();
    const helpline = "If you're struggling, iCall is a free confidential helpline: 9152987821.";
    const medical = "This isn't medical advice. See a doctor for anything concerning you.";
    detail = detail.replaceAll(helpline, "").replaceAll(medical, "").trim();
    if (/condition|disorder|disease|diagnos|syndrome|injury|diabetes|hypertension/.test(combined)) detail += `\n\n${medical}`;
    if (/mental health|anxiety|depression|burnout|stress|suicid|self-harm/.test(combined)) detail += `\n\n${helpline}`;
    detail = detail.trim();
  }
  draft.detail = detail;
  return draft;
}

function draftMeetsStructure(topic: EditorialTopic, draft: Record<string, any>): boolean {
  return validationReport(topic, draft).length === 0;
}

// Relaxed bar for the never-empty fallback: shorter is OK, but it must still carry
// a usable summary + some analysis (source-bound) and the required safety lines.
function draftMeetsRelaxed(topic: EditorialTopic, draft: Record<string, any>): boolean {
  const summaryWords = words(draft.summary);
  const detailWords = words(draft.detail);
  if (summaryWords < 50 || detailWords < 120) return false;
  if (!String(draft.headline ?? "").trim()) return false;
  if (topic.slug === "markets-startups" && !String(draft.detail ?? "").includes("SEBI-registered advisor")) return false;
  return true;
}

function validationReport(topic: EditorialTopic, draft: Record<string, any>): string[] {
  const errors: string[] = [];
  const summaryWords = words(draft.summary);
  const detailWords = words(draft.detail);
  if (summaryWords < 85 || summaryWords > 150) errors.push(`summary_words:${summaryWords}`);
  if (detailWords < 280 || detailWords > 560) errors.push(`detail_words:${detailWords}`);
  if (!String(draft.headline ?? "").trim()) errors.push("missing_headline");
  if (topic.slug === "markets-startups" && !String(draft.detail ?? "").includes("SEBI-registered advisor")) errors.push("missing_investment_disclaimer");
  const forbidden = /\b(game-changer|let's dive in|the truth about|wealth-building|financial freedom|compounding miracle)\b|!/i;
  if (forbidden.test(JSON.stringify(draft))) errors.push("forbidden_voice");
  return errors;
}

async function fetchPublicArticleText(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; ShortlyEditorial/1.0)" } });
  if (!response.ok) throw new Error(`Article HTTP ${response.status}`);
  const { document } = parseHTML(await response.text());
  const parsed = new Readability(document as unknown as Document).parse();
  return (parsed?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 18000);
}

function words(value: unknown): number {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function indiaDateLabel(): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date());
}

async function openAiJson(apiKey: string, model: string, system: string, user: string, maxTokens: number): Promise<Record<string, any>> {
  // chatCompletionRaw retries on 429 (low tokens-per-minute account) and surfaces
  // clear quota/auth errors.
  const raw = await chatCompletionRaw(apiKey, model, system, user, maxTokens, { jsonMode: true, temperature: 0.2 });
  return JSON.parse(raw);
}
