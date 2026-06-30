import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { Readability } from "npm:@mozilla/readability@0.6.0";
import { parseHTML } from "npm:linkedom@0.18.12";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { parseFeed } from "../_shared/rss.ts";
import { CORPORATE_CASE_SOURCES } from "../_shared/corporate-case-sources.ts";
import { summarizeForBriefing, chatCompletionRaw } from "../_shared/summary-clean.ts";

type Candidate = {
  title: string;
  url: string;
  excerpt: string;
  source: string;
  sourceWeight: number;
  publishedAt: string | null;
};

type RankedCandidate = {
  url: string;
  company?: string;
  case_type?: string;
  selection_reason?: string;
};

const CASE_TYPES = new Set(["listed", "startup", "consumer", "failure", "compounder"]);
// Kept small: low OpenAI tokens-per-minute account. Re-scrape for more.
const MAX_SHORT_ARTICLE_CARDS_PER_RUN = 6;
const EDITOR_CHECKLIST = [
  "Original article link verified and still accessible.",
  "Every number traced back to the source article.",
  "Any analogy or parallel flagged as agent inference; writer to verify.",
  "Bull case and bear case both surfaced; weighting confirmed.",
  "No quotes over 15 words; only one quote from the source."
];

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  if (request.method === "GET") {
    const { data, error } = await supabase
      .from("corporate_cases")
      .select("*")
      .order("generated_at", { ascending: false })
      .limit(200);
    if (error) return json({ error: error.message }, 500);
    return json({ cases: data ?? [] });
  }

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await request.json().catch(() => ({}));

  if (["update", "approve", "reject"].includes(String(body.action ?? ""))) {
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id is required" }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.action === "approve") patch.status = "approved";
    if (body.action === "reject") patch.status = "rejected";
    if (body.action === "update") {
      if ("headline" in body) patch.headline = String(body.headline ?? "").trim();
      if ("summary" in body) patch.summary = String(body.summary ?? "").trim();
      if ("detail" in body) patch.detail = String(body.detail ?? "").trim();
    }
    const { data, error } = await supabase
      .from("corporate_cases")
      .update(patch)
      .eq("id", id)
      .select("*")
      .single();
    if (error) return json({ error: error.message }, 500);
    return json({ case: data });
  }

  const sourceErrors: Array<{ source: string; error: string }> = [];
  const candidates = await collectCandidates(sourceErrors);
  if (candidates.length === 0) {
    return json({ error: "No corporate case candidates were found", sourceErrors }, 502);
  }
  const openAiKey = requiredEnv("OPENAI_API_KEY");
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
  const shortArticlesInserted = await upsertCorporateShortArticles(supabase, candidates, openAiKey, model);

  const { data: recent } = await supabase
    .from("corporate_cases")
    .select("source_url")
    .gte("generated_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());
  const recentUrls = new Set((recent ?? []).map((row) => row.source_url as string));
  const freshCandidates = candidates.filter((candidate) => !recentUrls.has(candidate.url));
  const selectionPool = freshCandidates.length > 0 ? freshCandidates : candidates;

  const ranked = await rankCandidates(openAiKey, model, selectionPool);
  const candidatesByUrl = new Map(selectionPool.map((candidate) => [candidate.url, candidate]));
  const rankedUrls = ranked
    .filter((item) => isValidCompanySelection(item, candidatesByUrl.get(item.url)))
    .map((item) => item.url);

  if (rankedUrls.length === 0) {
    return json({
      error: "No company-focused case study with enough evidence was found in the current source pool.",
      scanned: selectionPool.length,
      shortArticlesInserted,
      sourceErrors
    }, 422);
  }

  const rows: Array<Record<string, unknown>> = [];
  const failures: Array<{ url: string; error: string }> = [];
  for (const url of [...new Set(rankedUrls)]) {
    const candidate = candidatesByUrl.get(url);
    if (!candidate) continue;
    const articleText = await fetchPublicArticleText(candidate.url).catch((error) => {
      failures.push({ url: candidate.url, error: String(error) });
      return "";
    });
    const usableText = articleText.length >= 1800 ? articleText : candidate.excerpt;
    if (usableText.length < 1200) {
      failures.push({ url: candidate.url, error: "Not enough public source text" });
      continue;
    }
    const selectionMeta = ranked.find((item) => item.url === url) ?? { url };
    try {
      const row = await buildCaseRow(openAiKey, model, candidate, usableText, selectionMeta);
      rows.push(row);
    } catch (error) {
      failures.push({ url: candidate.url, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (rows.length === 0) {
    return json({
      error: "Candidates were found, but none exposed enough public source text for an evidence-based case study.",
      scanned: selectionPool.length,
      shortArticlesInserted,
      sourceErrors,
      failures: failures.slice(0, 10)
    }, 422);
  }

  const { data, error } = await supabase
    .from("corporate_cases")
    .upsert(rows, { onConflict: "source_url" })
    .select("*");
  if (error) return json({ error: error.message }, 500);

  return json({
    cases: data ?? [],
    inserted: data?.length ?? 0,
    shortArticlesInserted,
    scanned: candidates.length,
    freshCandidates: freshCandidates.length,
    sourceErrors,
    failures: failures.slice(0, 10)
  });
});

async function buildCaseRow(
  apiKey: string,
  model: string,
  selected: Candidate,
  sourceText: string,
  selectionMeta: RankedCandidate
) {
  let draft = await writeCase(apiKey, model, selected, sourceText, selectionMeta);
  if (!draftMeetsStructure(draft)) {
    draft = await repairCase(apiKey, model, selected, sourceText, selectionMeta, draft);
  }
  if (needsExpansion(draft)) {
    draft = await expandShortDetail(apiKey, model, selected, sourceText, draft);
  }
  if (!draftMeetsStructure(draft)) {
    draft = await repairCase(apiKey, model, selected, sourceText, selectionMeta, draft);
  }
  if (needsExpansion(draft)) {
    draft = await expandShortDetail(apiKey, model, selected, sourceText, draft);
  }
  if (!draftMeetsStructure(draft)) {
    throw new Error(`Generated case failed structure for ${selectionMeta.company ?? selected.title}: summary_words=${wordCount(String(draft.summary ?? ""))}, detail_words=${wordCount(String(draft.detail ?? ""))}`);
  }
  const caseType = inferCaseType(draft.case_type, sourceText);
  // No credit/link in the body. The source link is rendered separately — the
  // email shows a "Read the full source" link and the website a "Read the
  // source" button, both from source_url — so an inline credit is pure
  // duplication. Strip any templated credit, "Source:" line, or stray source
  // URL the model may still emit.
  const creditedDetail = String(draft.detail ?? "")
    .replace(/This case study draws on [^\n]*?Read the full piece here:[^\n]*\n*/gi, "")
    .replace(/^\s*Source:[^\n]*$/gim, "")
    .replace(new RegExp(`[^\\n]*${escapeRegExp(selected.url)}[^\\n]*\\n*`, "gi"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    source_url: selected.url,
    source_title: selected.title,
    source: selected.source,
    company: String(selectionMeta.company || draft.company || "").trim() || null,
    headline: String(draft.headline || selected.title).trim(),
    case_type: caseType,
    summary: String(draft.summary || "").trim(),
    detail: creditedDetail,
    comparison_or_analogy: String(draft.comparison_or_analogy || "").trim() || null,
    bull_case: String(draft.bull_case || "").trim() || null,
    bear_case: String(draft.bear_case || "").trim() || null,
    open_question: String(draft.open_question || "").trim() || null,
    inference_notes: Array.isArray(draft.inference_notes) ? draft.inference_notes : [],
    editor_checklist: EDITOR_CHECKLIST,
    selection_reason: String(selectionMeta.selection_reason || draft.selection_reason || "").trim() || null,
    source_excerpt: sourceText.slice(0, 12000),
    source_published_at: selected.publishedAt,
    status: "draft",
    generated_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

async function upsertCorporateShortArticles(supabase: any, candidates: Candidate[], openAiKey: string, model: string): Promise<number> {
  // Skip URLs we already have so each run summarizes genuinely NEW cases.
  const recentSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: existingRows } = await supabase
    .from("articles")
    .select("url")
    .eq("category", "Corporate Case")
    .gte("scraped_at", recentSince)
    .limit(5000);
  const existingUrls = new Set((existingRows ?? []).map((r: any) => r.url as string));
  const eligible = candidates
    .filter((candidate) => isLikelyCompanyCase(candidate.title, candidate.url))
    .filter((candidate) => !existingUrls.has(candidate.url))
    .slice(0, MAX_SHORT_ARTICLE_CARDS_PER_RUN);
  const rows = await mapWithConcurrency(eligible, 1, async (candidate) => {
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
      return null;
    }
    if (!candidate.title || !candidate.url || summary.split(/\s+/).filter(Boolean).length < 35) return null;
    return {
      title: candidate.title.trim().slice(0, 500),
      url: candidate.url,
      raw_content: rawContent.slice(0, 12000),
      summary,
      source: candidate.source,
      topic: "Corporate Case",
      category: "Corporate Case",
      section,
      status: "summarized",
      prominence,
      rank_score: candidate.sourceWeight,
      scraped_at: candidate.publishedAt ?? new Date().toISOString(),
      summarized_at: new Date().toISOString()
    };
  });
  const validRows = rows.filter((row): row is NonNullable<typeof row> => Boolean(row));
  if (validRows.length === 0) return 0;
  const { data, error } = await supabase
    .from("articles")
    .upsert(validRows, { onConflict: "url", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(error.message);
  return data?.length ?? validRows.length;
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

function summarizeSourceText(rawContent: string, fallback: string): string {
  const cleaned = String(rawContent || fallback || "")
    .replace(/\s+/g, " ")
    .replace(/^(listen to this article|read this article|advertisement)\b[:\s-]*/i, "")
    .trim();
  if (!cleaned) return "";
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20);
  const picked: string[] = [];
  let words = 0;
  for (const sentence of sentences) {
    const count = sentence.split(/\s+/).filter(Boolean).length;
    if (words >= 90 && picked.length >= 2) break;
    picked.push(sentence);
    words += count;
    if (words >= 130) break;
  }
  const summary = (picked.length ? picked.join(" ") : cleaned).trim();
  return summary.split(/\s+/).slice(0, 140).join(" ");
}

async function collectCandidates(sourceErrors: Array<{ source: string; error: string }>): Promise<Candidate[]> {
  const cutoff = Date.now() - 5 * 24 * 60 * 60 * 1000;
  const collected: Candidate[] = [];

  await Promise.all(CORPORATE_CASE_SOURCES.map(async (source) => {
    try {
      const response = await fetch(source.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ShortlyCorporateCase/1.0)" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const items = parseFeed(await response.text());
      for (const item of items) {
        if (source.accepts && !source.accepts(item.url)) continue;
        if (!isLikelyCompanyCase(item.title, item.url)) continue;
        const published = item.publishedAt ? new Date(item.publishedAt) : null;
        if (published && !Number.isNaN(published.getTime()) && published.getTime() < cutoff) continue;
        collected.push({
          title: item.title,
          url: item.url,
          excerpt: item.description.slice(0, 1800),
          source: source.name,
          sourceWeight: source.weight,
          publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null
        });
      }
    } catch (error) {
      sourceErrors.push({ source: source.name, error: String(error) });
    }
  }));

  const byUrl = new Map<string, Candidate>();
  for (const candidate of collected) byUrl.set(candidate.url, candidate);
  return [...byUrl.values()].sort((a, b) => {
    const timeA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const timeB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return (timeB - timeA) || (b.sourceWeight - a.sourceWeight);
  });
}

async function rankCandidates(apiKey: string, model: string, candidates: Candidate[]): Promise<RankedCandidate[]> {
  const compact = candidates.slice(0, 60).map((candidate) => ({
    title: candidate.title,
    url: candidate.url,
    source: candidate.source,
    published_at: candidate.publishedAt,
    excerpt: candidate.excerpt.slice(0, 650)
  }));

  const prompt = `Rank the best Indian corporate case-study candidates for a five-minute editorial brief.

Selection order:
1. Interesting or counter-intuitive business question.
2. Enough substance: financials, named decisions, unit economics, or real numbers.
3. Prefer the last 24-48 hours, but use up to five days if stronger.
4. Lead with the business model, never founder personality.
5. Prefer a useful weekly mix: listed, startup, consumer, failure, compounder.
6. The article must focus on a named company. Reject personal finance, deposits, tax advice, stock tips, macroeconomics, policy-only stories, and generic industry explainers.

Return JSON only:
{"ranked":[{"url":"exact candidate URL","company":"name","case_type":"listed|startup|consumer|failure|compounder","selection_reason":"one sentence"}]}

Return up to five candidates, strongest first. Use only URLs supplied below.

CANDIDATES:
${JSON.stringify(compact)}`;
  const parsed = await openAiJson(apiKey, model, "You are a rigorous Indian business editor selecting source-backed case studies.", prompt, 1200);
  return Array.isArray(parsed.ranked) ? parsed.ranked : [];
}

async function writeCase(
  apiKey: string,
  model: string,
  candidate: Candidate,
  sourceText: string,
  selection: RankedCandidate
): Promise<Record<string, unknown>> {
  const prompt = `Draft a Corporate Case for Shortly using only the source material below.

Required structure:
- headline: precise and business-model led.
- summary: 90-110 words. Who the company is, what it does, and the interesting business question. Complete on its own.
- detail: 320-480 words of fresh analysis. Do NOT restate or paraphrase the summary's opening sentence — the reader has just read it; open the detail instead on the business model or the central strategic tension. Do NOT write a source-credit, "according to", or "the article reports" sentence, and do NOT include the source URL or a "read the full piece" line — the source link is shown separately by the app. Cover the business model, unit economics where the source provides them, the strategic call, luck versus skill, bull case, bear case, and the open question.
- comparison_or_analogy: at least one direct comparable, historical parallel, counterfactual, or analogy. Write it as a plain declarative sentence; if it is your own inference rather than the source's, end it with "(our inference)" — never open with hedging scaffolding like "An inference can be made that".
- bull_case and bear_case: weighted by evidence, not false balance.
- open_question: one concrete thing to watch.
- inference_notes: array of every inference or analogy the editor must verify.

Hard rules:
- Every factual claim and every number must come from the supplied source text.
- Do not use latent knowledge for company facts or numbers.
- Do not invent missing unit economics. State that the source does not provide them.
- Lead with the business model, never the founder. Open on what the company does, not who runs it; the founder appears only when relevant to a specific decision. No founder-quote openings ("As [founder] once said...").
- Banned phrases: "disrupting", "10x growth", "category-defining", "rocketship", "legendary founder", "this is just the beginning", "An inference can be made that". No "lessons for entrepreneurs" closer, no press-release language, no exclamation marks.
- Do not repeat the summary's opening in the detail, and do not end the detail by restating the company's decision or summarising what you already said. Close on the open question or the specific forward-looking tension a reader should watch.
- State which side (bull or bear) has the numbers and which has the vibes; weight by evidence, never "some say good, some say bad".
- Be honest about luck versus skill; if you are guessing, say "we're guessing".
- At most one source quote, under 15 words. Prefer no direct quote.
- Define business jargon the first time it appears.
- Total summary + detail should be 400-600 words.
- The company field must name the company in the source article. Never use "Shortly" as the company.

Return JSON only with these keys:
{"headline":"","company":"","case_type":"listed|startup|consumer|failure|compounder","summary":"","detail":"","comparison_or_analogy":"","bull_case":"","bear_case":"","open_question":"","inference_notes":[],"selection_reason":""}

SOURCE PUBLICATION: ${candidate.source}
SOURCE TITLE: ${candidate.title}
SOURCE URL: ${candidate.url}
SELECTION CONTEXT: ${selection.selection_reason ?? ""}

SOURCE TEXT:
${sourceText.slice(0, 18000)}`;

  return await openAiJson(apiKey, model, "You are the final drafting voice for Shortly's Corporate Case. Be analytical, skeptical, source-bound, and concise.", prompt, 2200);
}

async function repairCase(
  apiKey: string,
  model: string,
  candidate: Candidate,
  sourceText: string,
  selection: RankedCandidate,
  draft: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const prompt = `Repair this Corporate Case draft so it follows the required structure exactly.

Requirements:
- summary: 90-110 words.
- detail: 330-450 words before the editor checklist.
- summary + detail: 430-570 words total.
- company must be the named company from the source, never Shortly.
- preserve only facts and numbers present in the source text.
- include business model, strategic call, luck versus skill, weighted bull/bear case, open question, and at least one clearly flagged inference/comparison.
- the detail must not restate the summary's opening, must not include any source-credit sentence, "read the full piece" line, or the source URL (the source link is shown separately by the app), and must not close by restating the decision — end on the open question or forward-looking tension.
- flag any inference as a plain sentence ending in "(our inference)", never "An inference can be made that".
- no founder worship, marketing language, exclamation marks, or entrepreneur lessons.

Return the same JSON keys as the current draft and no extra text.

SOURCE: ${candidate.source}
SOURCE TITLE: ${candidate.title}
SOURCE URL: ${candidate.url}
EXPECTED COMPANY: ${selection.company ?? "Identify it from the source"}

CURRENT DRAFT:
${JSON.stringify(draft)}

SOURCE TEXT:
${sourceText.slice(0, 18000)}`;
  return await openAiJson(apiKey, model, "You are a strict source-bound editor repairing a Corporate Case draft.", prompt, 2400);
}

async function expandShortDetail(
  apiKey: string,
  model: string,
  candidate: Candidate,
  sourceText: string,
  draft: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const summaryWords = wordCount(String(draft.summary ?? ""));
  const detailWords = wordCount(String(draft.detail ?? ""));
  const targetWords = Math.max(320 - detailWords, 410 - summaryWords - detailWords, 35);
  const prompt = `Write one additional analytical paragraph of ${targetWords}-${targetWords + 15} words for this Corporate Case.

Use only facts present in the source text. Add useful analysis that the current detail omitted, prioritising the business model, unit economics if available, luck versus skill, or the weighted bull/bear tension. Do not repeat the headline, summary, source credit, or open question. No marketing language or exclamation marks.

Return JSON only: {"paragraph":""}

CURRENT DETAIL:
${String(draft.detail ?? "")}

SOURCE TEXT:
${sourceText.slice(0, 18000)}

SOURCE URL: ${candidate.url}`;
  const addition = await openAiJson(apiKey, model, "You add a concise, source-bound analytical paragraph without inventing facts.", prompt, 700);
  const paragraph = String(addition.paragraph ?? "").trim();
  if (!paragraph) return draft;
  return { ...draft, detail: `${String(draft.detail ?? "").trim()}\n\n${paragraph}` };
}

function needsExpansion(draft: Record<string, unknown>): boolean {
  const summaryWords = wordCount(String(draft.summary ?? ""));
  const detailWords = wordCount(String(draft.detail ?? ""));
  return summaryWords >= 85 && summaryWords <= 120 &&
    (detailWords < 300 || summaryWords + detailWords < 400);
}

function draftMeetsStructure(draft: Record<string, unknown>): boolean {
  const summaryWords = wordCount(String(draft.summary ?? ""));
  const detailWords = wordCount(String(draft.detail ?? ""));
  const totalWords = summaryWords + detailWords;
  const company = String(draft.company ?? "").trim().toLowerCase();
  return summaryWords >= 85 && summaryWords <= 120 &&
    detailWords >= 300 && detailWords <= 500 &&
    totalWords >= 400 && totalWords <= 600 &&
    company.length > 1 && company !== "shortly";
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferCaseType(value: unknown, sourceText: string): string {
  const source = sourceText.toLowerCase();
  if (/\b(nse|bse|listed on|listed company|shares|stock price)\b/.test(source)) return "listed";
  if (/\b(bankruptcy|insolvency|shut down|shutdown|ceased operations)\b/.test(source)) return "failure";
  const proposed = String(value ?? "");
  return CASE_TYPES.has(proposed) ? proposed : "startup";
}

function isLikelyCompanyCase(title: string, url: string): boolean {
  const haystack = `${title} ${url}`.toLowerCase();
  const blocked = [
    "/wealth/", "/personal-finance/", "/mutual-funds/", "/insurance/", "/tax/",
    "fixed deposit", "fcnr", "income tax", "tax return", "mutual fund", "stock to buy",
    "gold price", "silver price", "home loan", "credit score", "investment tips"
  ];
  return !blocked.some((term) => haystack.includes(term));
}

function isValidCompanySelection(item: RankedCandidate, candidate?: Candidate): boolean {
  if (!candidate) return false;
  const company = String(item.company ?? "").trim();
  if (company.length < 2 || company.toLowerCase() === "shortly") return false;
  const normalizedCompany = company.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedSource = `${candidate.title} ${candidate.excerpt}`.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalizedCompany.length >= 2 && normalizedSource.includes(normalizedCompany);
}

async function fetchPublicArticleText(url: string): Promise<string> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ShortlyCorporateCase/1.0)" }
  });
  if (!response.ok) throw new Error(`Article HTTP ${response.status}`);
  const html = await response.text();
  const { document } = parseHTML(html);
  const parsed = new Readability(document as unknown as Document).parse();
  const text = parsed?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return text.slice(0, 24000);
}

async function openAiJson(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number
): Promise<Record<string, any>> {
  // chatCompletionRaw retries on 429 (low tokens-per-minute account).
  const raw = await chatCompletionRaw(apiKey, model, system, user, maxTokens, { jsonMode: true, temperature: 0.2 });
  return JSON.parse(raw);
}
