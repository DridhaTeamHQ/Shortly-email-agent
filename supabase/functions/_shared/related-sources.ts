// _shared/related-sources.ts
// Finds OTHER outlets in our own scrape pool that covered the SAME story, so the
// fact check can corroborate claims across independent sources and the UI can
// show "Checked across N sources". No web search, no new API — it clusters the
// articles we already pull from 60+ RSS feeds.
//
// Matching is by significant-title-token overlap within a recent window. It is
// deliberately conservative (needs a real entity/number overlap, not just
// shared filler words) so unrelated stories are not falsely grouped. This is a
// heuristic, not semantic clustering — a missed sibling just means a lower
// source count, never a wrong fact.

export type RelatedSource = {
  source: string;
  url: string;
  title: string;
  excerpt: string;
};

// Common words that carry no story identity — never count them as a shared token.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "to", "of", "in", "on", "at", "by",
  "with", "from", "as", "is", "are", "was", "were", "be", "been", "has", "have",
  "had", "will", "would", "can", "could", "may", "might", "this", "that", "these",
  "those", "it", "its", "his", "her", "their", "our", "your", "not", "no", "new",
  "over", "after", "before", "into", "out", "up", "down", "off", "more", "most",
  "amid", "says", "said", "report", "reports", "reportedly", "how", "why", "what",
  "when", "who", "which", "top", "big", "set", "get", "gets", "day", "year", "years",
  "week", "india", "indian",
]);

// Significant tokens = words that identify the story: length >= 4, not a
// stopword, OR any token containing a digit (figures/dates are strong signals).
function significantTokens(title: string): string[] {
  const raw = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const hasDigit = /\d/.test(t);
    if (!hasDigit && (t.length < 4 || STOPWORDS.has(t))) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const RELATED_WINDOW_MS = 48 * 60 * 60 * 1000;
const MIN_SHARED_TOKENS = 3;     // need 3 shared significant tokens...
const MIN_JACCARD = 0.28;        // ...or a strong overall overlap
const MAX_RELATED = 4;           // cap corroborating outlets we record/prompt

// Semantic sibling matching via title embeddings (pgvector RPC
// match_related_articles). Cosine distance under MAX_EMBED_DISTANCE means
// "same story even when worded completely differently" — far better recall
// than token overlap. Returns null when no embedding is available so the
// caller falls back to token matching.
const MAX_EMBED_DISTANCE = 0.4;

async function findByEmbedding(
  supabase: any,
  article: { id?: string; source?: string | null; url?: string | null; embedding?: number[] | null },
  since: string,
  until: string
): Promise<RelatedSource[] | null> {
  try {
    let embedding: number[] | null = article.embedding ?? null;
    if (!embedding && article.id) {
      const { data } = await supabase.from("articles").select("title_embedding").eq("id", article.id).maybeSingle();
      const raw = data?.title_embedding;
      if (typeof raw === "string") { try { embedding = JSON.parse(raw); } catch { embedding = null; } }
      else if (Array.isArray(raw)) embedding = raw;
    }
    if (!embedding || embedding.length === 0) return null;

    const { data: rows, error } = await supabase.rpc("match_related_articles", {
      p_embedding: embedding,
      p_since: since,
      p_until: until,
      p_exclude_id: article.id ?? null,
      p_exclude_source: article.source ?? null,
      p_max_distance: MAX_EMBED_DISTANCE,
      p_limit: 10,
    });
    if (error || !rows) return null;

    const selfUrl = String(article.url || "");
    const perSource = new Set<string>();
    const out: RelatedSource[] = [];
    for (const row of rows) {
      if (!row?.title || !row?.url || row.url === selfUrl) continue;
      const key = String(row.source || row.url).toLowerCase();
      if (perSource.has(key)) continue;
      perSource.add(key);
      out.push({
        source: String(row.source || "").trim() || "Other outlet",
        url: String(row.url),
        title: String(row.title).trim().slice(0, 300),
        excerpt: String(row.summary || "").trim().slice(0, 240),
      });
      if (out.length >= MAX_RELATED) break;
    }
    return out;
  } catch {
    return null;
  }
}

// Returns up to MAX_RELATED sibling articles from DIFFERENT sources covering the
// same story. Never throws — on any error it returns [] so scoring proceeds
// single-source.
//
// Matching order: EMBEDDING similarity first (semantic — catches the same story
// under completely different headlines), token overlap as the fallback when the
// row has no embedding yet.
//
// The sibling window is anchored on the article's OWN scrape time (±48h) when
// `scrapedAt` is provided — essential for backfills and approval-time scoring,
// where "last 48h from now" would miss the story's real contemporaries entirely.
// Without an anchor it falls back to now (scrape-time behaviour, unchanged).
export async function findRelatedSources(
  supabase: any,
  article: { id?: string; title: string; source?: string | null; url?: string | null; scrapedAt?: string | null; embedding?: number[] | null }
): Promise<RelatedSource[]> {
  try {
    {
      const anchorMs0 = article.scrapedAt ? new Date(article.scrapedAt).getTime() : Date.now();
      const anchor0 = Number.isFinite(anchorMs0) ? anchorMs0 : Date.now();
      const viaEmbedding = await findByEmbedding(
        supabase,
        article,
        new Date(anchor0 - RELATED_WINDOW_MS).toISOString(),
        new Date(anchor0 + RELATED_WINDOW_MS).toISOString()
      );
      if (viaEmbedding) return viaEmbedding;
    }
    const tokens = significantTokens(article.title);
    if (tokens.length < 2) return [];
    const tokenSet = new Set(tokens);
    // Query on the few most distinctive tokens (longest first — proper nouns and
    // numbers tend to be longer/rarer) to keep the candidate set small.
    const probes = [...tokens].sort((a, b) => b.length - a.length).slice(0, 5);
    const anchorMs = article.scrapedAt ? new Date(article.scrapedAt).getTime() : Date.now();
    const anchor = Number.isFinite(anchorMs) ? anchorMs : Date.now();
    const since = new Date(anchor - RELATED_WINDOW_MS).toISOString();
    const until = new Date(anchor + RELATED_WINDOW_MS).toISOString();

    let query = supabase
      .from("articles")
      .select("id,title,url,source,summary")
      .gte("scraped_at", since)
      .lte("scraped_at", until)
      .neq("status", "rejected")
      .or(probes.map((t) => `title.ilike.%${t}%`).join(","))
      .limit(60);
    if (article.id) query = query.neq("id", article.id);

    const { data, error } = await query;
    if (error || !data) return [];

    const selfSource = String(article.source || "").toLowerCase();
    const selfUrl = String(article.url || "");
    const scored: Array<{ row: any; shared: number; jac: number }> = [];
    for (const row of data) {
      if (!row?.title || !row?.url) continue;
      if (row.url === selfUrl) continue;
      // Independent outlet only: skip the same source (corroboration must come
      // from a DIFFERENT publisher to mean anything).
      if (String(row.source || "").toLowerCase() === selfSource) continue;
      const cand = new Set(significantTokens(row.title));
      let shared = 0;
      for (const t of cand) if (tokenSet.has(t)) shared++;
      const jac = jaccard(tokenSet, cand);
      if (shared >= MIN_SHARED_TOKENS || jac >= MIN_JACCARD) {
        scored.push({ row, shared, jac });
      }
    }

    // Best matches first; keep one article per distinct source.
    scored.sort((a, b) => b.shared - a.shared || b.jac - a.jac);
    const perSource = new Set<string>();
    const out: RelatedSource[] = [];
    for (const { row } of scored) {
      const key = String(row.source || row.url).toLowerCase();
      if (perSource.has(key)) continue;
      perSource.add(key);
      out.push({
        source: String(row.source || "").trim() || "Other outlet",
        url: String(row.url),
        title: String(row.title).trim().slice(0, 300),
        excerpt: String(row.summary || "").trim().slice(0, 240),
      });
      if (out.length >= MAX_RELATED) break;
    }
    return out;
  } catch {
    return [];
  }
}
