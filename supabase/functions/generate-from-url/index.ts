// generate-from-url: turn a QA-pasted article URL into either a short summarized
// article (mode:'short', lands in `articles` as 'summarized') or a source-bound
// case study (mode:'case', lands in `editorial_drafts` as 'draft') — using the
// exact same summary/fact-check/case-writer helpers the automated pipelines use.
//
// ANON-callable (verify_jwt is handled by the gateway, same as scrape-news):
// no admin gate, it just uses the service-role client internally. Dedupe happens
// BEFORE any OpenAI spend, and the fetched page text only ever enters fenced
// prompt blocks (summarizeForBriefing/factCheckArticle/buildCaseRow all fence).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { fetchReadablePage } from "../_shared/article-text.ts";
import { summarizeForBriefing } from "../_shared/summary-clean.ts";
import { factCheckArticle } from "../_shared/fact-check.ts";
import { findRelatedSources } from "../_shared/related-sources.ts";
import { embedText } from "../_shared/embeddings.ts";
import { buildCaseRow } from "../_shared/editorial-case.ts";
import { getEditorialTopic, type EditorialTopic } from "../_shared/editorial-topics.ts";

const SHORT_CATEGORIES = ["Real Estate", "Automobile", "Health & Wellness", "Tech & AI", "Markets & Startups"];

// SSRF guard: reject loopback, link-local, and RFC-1918 private ranges plus
// internal TLDs so a pasted URL can't be used to probe the private network.
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h === "0.0.0.0" || h === "::1") return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

function hostnameSource(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const body = await request.json().catch(() => ({}));
  const rawUrl = String(body.url ?? "").trim();
  const mode = String(body.mode ?? "");
  const category = body.category == null ? "" : String(body.category).trim();
  const topicSlug = String(body.topic ?? "").trim();

  // 1. Validate URL + SSRF guard.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return json({ error: "invalid_url", detail: "Enter a valid http(s) URL." }, 400);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return json({ error: "invalid_url", detail: "Enter a valid http(s) URL." }, 400);
  }
  if (isBlockedHost(parsedUrl.hostname)) {
    return json({ error: "invalid_url", detail: "That host is not allowed." }, 400);
  }
  const url = parsedUrl.toString();

  // 2. Validate mode-specific inputs.
  if (mode !== "short" && mode !== "case") {
    return json({ error: "invalid_mode", detail: "mode must be 'short' or 'case'." }, 400);
  }
  let topicObj: EditorialTopic | null = null;
  if (mode === "short") {
    const okCategory = category === "" || category === "General" || SHORT_CATEGORIES.includes(category);
    if (!okCategory) return json({ error: "invalid_category" }, 400);
  } else {
    topicObj = getEditorialTopic(topicSlug);
    if (!topicObj) return json({ error: "invalid_topic", detail: "Unknown topic." }, 400);
  }

  // 3. Dedupe BEFORE any OpenAI spend.
  {
    const { data: existing } = await supabase.from("articles").select("id,status").eq("url", url).maybeSingle();
    if (existing) {
      return json({ error: "already_exists", detail: "This URL is already in the system.", id: existing.id, status: existing.status }, 200);
    }
  }
  if (mode === "case") {
    const { data: existingDraft } = await supabase
      .from("editorial_drafts")
      .select("id")
      .eq("primary_source_url", url)
      .maybeSingle();
    if (existingDraft) {
      return json({ error: "already_exists", detail: "This URL is already in the system.", id: existingDraft.id, status: "draft" }, 200);
    }
  }

  // 4. Fetch + extract readable page.
  let page: { title: string | null; text: string };
  try {
    page = await fetchReadablePage(url);
  } catch {
    return json({ error: "fetch_failed", detail: "Could not fetch that page." }, 200);
  }
  const text = page.text ?? "";
  if (text.trim().length < 400) {
    return json({ error: "paywall_or_empty", detail: "Could not extract enough readable text — the page may be paywalled or JS-only." }, 200);
  }
  const source = hostnameSource(parsedUrl.hostname);
  const title = page.title || url;

  const openAiKey = requiredEnv("OPENAI_API_KEY");

  // 5. Short article.
  if (mode === "short") {
    const model = Deno.env.get("SUMMARIZE_MODEL") ?? "gpt-4o-mini";
    const result = await summarizeForBriefing(openAiKey, model, { title, source, url, excerpt: text });
    const embedding = await embedText(openAiKey, title);
    const related = await findRelatedSources(supabase, { title, source, url, embedding });
    const fact = await factCheckArticle(openAiKey, {
      title,
      summary: result.summary,
      sourceText: text,
      primarySource: { source, url },
      relatedSources: related,
    });
    const normalizedCategory = category && category !== "General" ? category : null;
    const row: Record<string, unknown> = {
      title: title.slice(0, 500),
      url,
      raw_content: text.slice(0, 12000),
      summary: result.summary,
      source,
      topic: category || null,
      category: normalizedCategory,
      section: result.section,
      status: "summarized",
      prominence: result.prominence,
      rank_score: fact ? 0.7 + 0.6 * (fact.fact_score / 100) : 1,
      fact_score: fact?.fact_score ?? null,
      fact_label: fact?.fact_label ?? null,
      fact_notes: fact?.fact_notes ?? null,
      scraped_at: new Date().toISOString(),
      summarized_at: new Date().toISOString(),
      ...(embedding ? { title_embedding: embedding } : {}),
    };
    const { data: inserted, error: insErr } = await supabase.from("articles").insert(row).select("id").single();
    if (insErr) {
      if (insErr.code === "23505") {
        return json({ error: "already_exists", detail: "This URL is already in the system." }, 200);
      }
      throw new Error(insErr.message);
    }
    return json({ ok: true, mode: "short", id: inserted.id });
  }

  // 6. Case study.
  const caseModel = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";
  const candidate = { title, url, source, excerpt: text };
  let row: Record<string, unknown>;
  try {
    row = await buildCaseRow(openAiKey, caseModel, topicObj!, candidate, text, { url });
  } catch {
    try {
      row = await buildCaseRow(openAiKey, caseModel, topicObj!, candidate, text, { url }, true);
    } catch {
      return json({ error: "generation_failed", detail: "Could not produce a source-bound case study from that page." }, 200);
    }
  }
  const { data: insertedDraft, error: draftErr } = await supabase
    .from("editorial_drafts")
    .insert(row)
    .select("id")
    .single();
  if (draftErr) throw new Error(draftErr.message);
  return json({ ok: true, mode: "case", id: insertedDraft.id });
}

Deno.serve(async (request) => {
  try {
    return await handleRequest(request);
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error);
    return json({ error: "server_error", detail }, 500);
  }
});
