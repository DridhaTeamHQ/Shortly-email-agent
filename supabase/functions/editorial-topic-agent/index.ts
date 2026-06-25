import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { Readability } from "npm:@mozilla/readability@0.6.0";
import { parseHTML } from "npm:linkedom@0.18.12";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { parseFeed } from "../_shared/rss.ts";
import { EDITORIAL_TOPICS, getEditorialTopic, type EditorialSource, type EditorialTopic } from "../_shared/editorial-topics.ts";

type Candidate = {
  title: string;
  url: string;
  excerpt: string;
  source: string;
  sourceWeight: number;
  publishedAt: string | null;
  compassOnly: boolean;
};

type Evidence = Candidate & { text: string };
const MAX_SMALL_ARTICLE_CARDS_PER_RUN = 40;

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
  const citedCandidates = candidates.filter((item) => !item.compassOnly);
  const minimum = topic.format === "hybrid" ? 4 : 1;
  if (citedCandidates.length < minimum) {
    return json({ error: `Only ${citedCandidates.length} usable cited candidates were found; ${minimum} required.`, sourceErrors }, 422);
  }
  const sourceArticleUrls = await upsertSourceCandidateArticles(supabase, topic, citedCandidates);

  const openAiKey = requiredEnv("OPENAI_API_KEY");
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
  const selectedUrls = await selectEvidence(openAiKey, model, topic, candidates);
  const selected = selectedUrls
    .map((selectedUrl) => candidates.find((candidate) => candidate.url === selectedUrl))
    .filter((candidate): candidate is Candidate => Boolean(candidate));
  const evidence = await buildEvidence(selected, topic.format === "hybrid" ? 8 : 4);
  const citedEvidence = evidence.filter((item) => !item.compassOnly);
  if (citedEvidence.length < minimum) {
    return json({ error: "Selected stories did not expose enough source text for a source-bound draft.", selected: selectedUrls, sourceErrors }, 422);
  }

  let content = await writeDraft(openAiKey, model, topic, evidence);
  content = enforceSafety(topic, content);
  if (!validDraft(topic, content)) {
    content = enforceSafety(topic, await repairDraft(openAiKey, model, topic, evidence, content));
  }
  if (needsExpansion(topic, content)) {
    content = enforceSafety(topic, await expandDraft(openAiKey, model, topic, evidence, content));
  }
  if (needsExpansion(topic, content)) {
    content = enforceSafety(topic, await expandDraft(openAiKey, model, topic, evidence, content));
  }
  if (!validDraft(topic, content)) {
    return json({ error: "Draft failed the topic's structure or safety validation.", validation: validationReport(topic, content) }, 422);
  }

  const primary = citedEvidence[0];
  const sourceLinks = citedEvidence.map((item) => ({ title: item.title, source: item.source, url: item.url }));
  const row = {
    topic_slug: topic.slug,
    topic_name: topic.name,
    format: topic.format,
    headline: String(content.headline ?? content.feature?.headline ?? "").trim(),
    summary: topic.format === "single" ? String(content.summary ?? "").trim() : String(content.feature?.summary ?? "").trim(),
    detail: topic.format === "single" ? String(content.detail ?? "").trim() : String(content.feature?.detail ?? "").trim(),
    briefing_items: topic.format === "hybrid" ? content.briefs : [],
    content,
    source_links: sourceLinks,
    primary_source_url: primary.url,
    primary_source_title: primary.title,
    editor_checklist: topic.checklist,
    inference_notes: Array.isArray(content.inference_notes) ? content.inference_notes : [],
    status: "draft",
    generated_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const { data, error } = await supabase.from("editorial_drafts").insert(row).select("*").single();
  if (error) return json({ error: error.message }, 500);

  const shortArticlesInserted = await countArticlesByUrl(supabase, sourceArticleUrls);

  return json({ draft: data, shortArticlesInserted, scanned: candidates.length, sourcesUsed: sourceLinks.length, sourceErrors });
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

function shortArticleCategory(topic: EditorialTopic): string {
  if (topic.slug === "real-estate") return "Real Estate";
  if (topic.slug === "policy-partner") return "Policy Partner";
  if (topic.slug === "money-matters") return "Money Matters";
  if (topic.slug === "wellness-daily") return "Wellness Daily";
  return topic.name;
}

async function upsertSourceCandidateArticles(
  supabase: any,
  topic: EditorialTopic,
  candidates: Candidate[]
): Promise<string[]> {
  const category = shortArticleCategory(topic);
  const eligibleCandidates = candidates
    .filter((candidate) => isEligibleSmallArticleSource(topic, candidate))
    .slice(0, MAX_SMALL_ARTICLE_CARDS_PER_RUN);
  const rows = await mapWithConcurrency(eligibleCandidates, 3, async (candidate) => {
    const articleText = await fetchPublicArticleText(candidate.url).catch(() => "");
    const rawContent = articleText.length >= 500 ? articleText : candidate.excerpt;
    const summary = summarizeSourceText(rawContent, candidate.excerpt);
    if (!isGoodSmallArticleCandidate(topic, candidate, rawContent, summary)) return null;
    return {
      title: candidate.title.trim().slice(0, 500),
      url: candidate.url,
      raw_content: rawContent.slice(0, 12000),
      summary,
      source: candidate.source,
      topic: category,
      category,
      section: "wrapped",
      status: "summarized",
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
    .upsert(validRows, { onConflict: "url" });
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
  if (topic.slug === "money-matters") {
    return /\b(money|tax|rbi|sebi|bank|mutual fund|insurance|loan|credit|debit|upi|invest|income|finance|market|stock|ipo|savings?|pension|fraud|scam)\b/i.test(`${title} ${summary}`);
  }
  if (topic.slug === "policy-partner") {
    return /\b(court|supreme court|high court|government|policy|law|bill|act|rules?|regulation|regulator|rights?|order|ministry|rbi|sebi|tax|public|citizen|consumer)\b/i.test(`${title} ${summary}`);
  }
  return true;
}

function isEligibleSmallArticleSource(topic: EditorialTopic, candidate: Candidate): boolean {
  if (candidate.compassOnly) return false;
  if (topic.slug === "money-matters") {
    return new Set(["Mint Money", "Moneycontrol", "Business Standard Finance"]).has(candidate.source);
  }
  if (topic.slug === "policy-partner") {
    return new Set(["Bar & Bench", "Indian Express Explained", "LiveLaw", "ThePrint Explained"]).has(candidate.source);
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

async function selectEvidence(apiKey: string, model: string, topic: EditorialTopic, candidates: Candidate[]): Promise<string[]> {
  const compact = candidates.slice(0, 80).map((item) => ({
    title: item.title, url: item.url, source: item.source, published_at: item.publishedAt,
    compass_only: item.compassOnly, excerpt: item.excerpt.slice(0, 550)
  }));
  const needed = topic.format === "hybrid" ? "Select 6-8 cited stories that can support five distinct briefs and one feature. Reddit may be selected only as an editorial question, never as cited evidence." : "Select 1-4 stories supporting one strong anchor. Reddit may guide the question but cannot be cited as evidence.";
  const prompt = `Select evidence for ${topic.name}.

INDIA DATE: ${indiaDateLabel()}

${topic.selection}
${needed}
Prefer the last 24-48 hours; use up to five days only for a stronger anchor. Return exact supplied URLs only.

Return JSON only: {"urls":["..."]}

CANDIDATES:
${JSON.stringify(compact)}`;
  const parsed = await openAiJson(apiKey, model, "You are a rigorous Indian publication assignment editor.", prompt, 1600);
  return Array.isArray(parsed.urls) ? parsed.urls.map(String) : [];
}

async function buildEvidence(candidates: Candidate[], limit: number): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  for (const candidate of candidates.slice(0, limit)) {
    if (candidate.compassOnly) {
      evidence.push({ ...candidate, text: candidate.excerpt });
      continue;
    }
    const article = await fetchPublicArticleText(candidate.url).catch(() => "");
    const text = article.length >= 900 ? article : candidate.excerpt;
    if (text.length >= 250) evidence.push({ ...candidate, text });
  }
  return evidence;
}

async function fetchPublicArticleText(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; ShortlyEditorial/1.0)" } });
  if (!response.ok) throw new Error(`Article HTTP ${response.status}`);
  const { document } = parseHTML(await response.text());
  const parsed = new Readability(document as unknown as Document).parse();
  return (parsed?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 18000);
}

async function writeDraft(apiKey: string, model: string, topic: EditorialTopic, evidence: Evidence[]) {
  const shape = topic.format === "hybrid"
    ? `{"headline":"issue headline","briefs":[{"headline":"","what_happened":"","why_it_matters":"","city":"","source_url":""}],"feature":{"headline":"","summary":"","detail":"","source_url":""},"inference_notes":[]}`
    : `{"headline":"","summary":"","detail":"","evidence_quality":"","indian_translation":"","source_url":"","inference_notes":[]}`;
  const prompt = `Draft ${topic.name} for a human editor.

INDIA DATE: ${indiaDateLabel()}

VIBE: ${topic.description}
SELECTION: ${topic.selection}
STRUCTURE: ${topic.structure}
VOICE: ${topic.voice}
SAFETY: ${topic.safety}

Hard rules:
- Use only facts, names and numbers in the supplied evidence.
- Credit and link cited reporting in the text. Reddit is compass-only and must never be cited as evidence.
- Paraphrase. At most one quote per source and under 15 words.
- Flag every analogy, extrapolation or unsourced Indian translation in inference_notes.
- Do not invent Indian salary, price, rent, health, tax, return or policy numbers.
- No exclamation marks.

Return JSON only in this shape:
${shape}

EVIDENCE:
${JSON.stringify(evidence.map((item) => ({ source: item.source, url: item.url, compass_only: item.compassOnly, title: item.title, text: item.text.slice(0, 9000) })))}`;
  return await openAiJson(apiKey, model, `You are the source-bound drafting agent for ${topic.name}.`, prompt, topic.format === "hybrid" ? 4200 : 2600);
}

async function repairDraft(apiKey: string, model: string, topic: EditorialTopic, evidence: Evidence[], draft: Record<string, any>) {
  const prompt = `Repair this ${topic.name} draft to satisfy every structural, sourcing, voice and safety rule.

STRUCTURE: ${topic.structure}
VOICE: ${topic.voice}
SAFETY: ${topic.safety}

Keep the same JSON shape. Use only supplied evidence. Do not cite Reddit. Return JSON only.

VALIDATION FAILURES: ${JSON.stringify(validationReport(topic, draft))}
CURRENT DRAFT: ${JSON.stringify(draft)}
EVIDENCE: ${JSON.stringify(evidence.map((item) => ({ source: item.source, url: item.url, compass_only: item.compassOnly, title: item.title, text: item.text.slice(0, 7000) })))}`;
  return await openAiJson(apiKey, model, "You are a strict source and safety editor.", prompt, topic.format === "hybrid" ? 4500 : 2800);
}

async function expandDraft(apiKey: string, model: string, topic: EditorialTopic, evidence: Evidence[], draft: Record<string, any>) {
  const target = topic.format === "hybrid" ? draft.feature ?? {} : draft;
  const summaryWords = words(target.summary);
  const detailWords = words(target.detail);
  const replaceSummary = summaryWords < 80;
  const detailAdditionWords = Math.max(320 - detailWords, 410 - Math.max(summaryWords, 95) - detailWords, 0);
  const shortBriefs = topic.format === "hybrid"
    ? (draft.briefs ?? []).map((brief: any, index: number) => ({
        index,
        words: words(`${brief.headline ?? ""} ${brief.what_happened ?? ""} ${brief.why_it_matters ?? ""}`)
      })).filter((brief: any) => brief.words < 50)
    : [];
  const prompt = `Expand only the undersized parts of this ${topic.name} draft using the supplied evidence.

${replaceSummary ? "Write a replacement summary of 95-110 words." : "Return an empty summary string because the existing summary is already long enough."}
${detailAdditionWords > 0 ? `Write one additional detail paragraph of ${detailAdditionWords}-${detailAdditionWords + 20} words.` : "Return an empty additional_detail string because no detail expansion is needed."}
${shortBriefs.length > 0 ? `For each short brief listed here, write one sourced addition of enough words to bring the full item close to 65 words: ${JSON.stringify(shortBriefs)}.` : "Return an empty brief_additions array because no briefs are short."}

Do not introduce any fact or number absent from the evidence. Do not repeat the source credit, headline, conclusion, disclaimer, or safety lines. Preserve the topic voice. No exclamation marks.

Return JSON only: {"summary":"","additional_detail":"","brief_additions":[{"index":0,"addition":""}]}

CURRENT DRAFT: ${JSON.stringify(draft)}
EVIDENCE: ${JSON.stringify(evidence.map((item) => ({ source: item.source, url: item.url, compass_only: item.compassOnly, title: item.title, text: item.text.slice(0, 6000) })))}`;
  const addition = await openAiJson(apiKey, model, "You expand editorial drafts without inventing or repeating facts.", prompt, 1600);
  if (replaceSummary && String(addition.summary ?? "").trim()) target.summary = String(addition.summary).trim();
  if (detailAdditionWords > 0 && String(addition.additional_detail ?? "").trim()) {
    target.detail = `${String(target.detail ?? "").trim()}\n\n${String(addition.additional_detail).trim()}`;
  }
  for (const item of Array.isArray(addition.brief_additions) ? addition.brief_additions : []) {
    const index = Number(item.index);
    if (!Number.isInteger(index) || !draft.briefs?.[index] || !String(item.addition ?? "").trim()) continue;
    draft.briefs[index].why_it_matters = `${String(draft.briefs[index].why_it_matters ?? "").trim()} ${String(item.addition).trim()}`.trim();
  }
  return draft;
}

function enforceSafety(topic: EditorialTopic, draft: Record<string, any>) {
  const detailTarget = topic.format === "hybrid" ? draft.feature : draft;
  if (!detailTarget) return draft;
  let detail = String(detailTarget.detail ?? "").trim();
  if (topic.slug === "money-matters") {
    const disclaimer = "This isn't investment advice. We don't know your situation. Talk to a SEBI-registered advisor before acting on anything you read here.";
    detail = detail.replaceAll(disclaimer, "").trim();
    detail = `${detail}\n\n${disclaimer}`;
  }
  if (topic.slug === "wellness-daily") {
    const combined = `${draft.headline ?? ""} ${draft.summary ?? ""} ${detail}`.toLowerCase();
    const helpline = "If you're struggling, iCall is a free confidential helpline: 9152987821.";
    const medical = "This isn't medical advice. See a doctor for anything concerning you.";
    detail = detail.replaceAll(helpline, "").replaceAll(medical, "").trim();
    if (/condition|disorder|disease|diagnos|syndrome|injury|diabetes|hypertension/.test(combined)) detail += `\n\n${medical}`;
    if (/mental health|anxiety|depression|burnout|stress|suicid|self-harm/.test(combined)) detail += `\n\n${helpline}`;
  }
  detailTarget.detail = detail;
  return draft;
}

function validDraft(topic: EditorialTopic, draft: Record<string, any>): boolean {
  return validationReport(topic, draft).length === 0;
}

function needsExpansion(topic: EditorialTopic, draft: Record<string, any>): boolean {
  const target = topic.format === "hybrid" ? draft.feature ?? {} : draft;
  const summaryWords = words(target.summary);
  const detailWords = words(target.detail);
  const hasShortBrief = topic.format === "hybrid" && (draft.briefs ?? []).some((brief: any) =>
    words(`${brief.headline ?? ""} ${brief.what_happened ?? ""} ${brief.why_it_matters ?? ""}`) < 50
  );
  return summaryWords < 80 || detailWords < 280 || summaryWords + detailWords < 380 || hasShortBrief;
}

function validationReport(topic: EditorialTopic, draft: Record<string, any>): string[] {
  const errors: string[] = [];
  const target = topic.format === "hybrid" ? draft.feature ?? {} : draft;
  const summaryWords = words(target.summary);
  const detailWords = words(target.detail);
  if (summaryWords < 80 || summaryWords > 130) errors.push(`summary_words:${summaryWords}`);
  if (detailWords < 280 || detailWords > 550) errors.push(`detail_words:${detailWords}`);
  if (!String(draft.headline ?? target.headline ?? "").trim()) errors.push("missing_headline");
  if (topic.format === "hybrid") {
    if (!Array.isArray(draft.briefs) || draft.briefs.length !== 5) errors.push(`brief_count:${draft.briefs?.length ?? 0}`);
    for (const [index, brief] of (draft.briefs ?? []).entries()) {
      const count = words(`${brief.headline ?? ""} ${brief.what_happened ?? ""} ${brief.why_it_matters ?? ""}`);
      if (count < 50 || count > 105) errors.push(`brief_${index + 1}_words:${count}`);
      if (!brief.source_url) errors.push(`brief_${index + 1}_missing_source`);
    }
  }
  if (!target.source_url) errors.push("missing_primary_source");
  if (topic.slug === "money-matters" && !String(target.detail ?? "").includes("SEBI-registered advisor")) errors.push("missing_investment_disclaimer");
  const forbidden = /\b(game-changer|let's dive in|the truth about|wealth-building|financial freedom|compounding miracle)\b|!/i;
  if (forbidden.test(JSON.stringify(draft))) errors.push("forbidden_voice");
  return errors;
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
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, temperature: 0.2, max_tokens: maxTokens, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });
  if (!response.ok) throw new Error(await openAiErrorMessage(response));
  const raw = (await response.json())?.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("OpenAI returned an empty response");
  return JSON.parse(raw);
}

async function openAiErrorMessage(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  if (response.status === 429 && body.includes("insufficient_quota")) {
    return "OpenAI quota exceeded. Add billing credits or replace OPENAI_API_KEY with a key from an account that has available quota, then run the scraper again.";
  }
  if (response.status === 401) {
    return "OpenAI API key is invalid or expired. Update OPENAI_API_KEY in Supabase secrets.";
  }
  return `OpenAI ${response.status}: ${body.slice(0, 220)}`;
}
