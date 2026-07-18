import { stripSourceArtifacts } from "./summary-clean.ts";

const INLINE_NOISE_PATTERNS = [
  /follow us on [^.?!]*/gi,
  /join (our|the) (telegram|whatsapp|facebook|instagram|x|twitter|linkedin) [^.?!]*/gi,
  /subscribe to (our )?(newsletter|channel|alerts)[^.?!]*/gi,
  /download (our )?app[^.?!]*/gi,
  /click here[^.?!]*/gi,
  /read more[^.?!]*/gi,
  /share (this|the article)[^.?!]*/gi,
  /advertisement/gi,
  /published on:\s*/gi,
  /updated on:\s*/gi
];

// Footer/legal furniture — safe to drop from any line, however long.
const FOOTER_LINE_PATTERNS = [
  /\b(all rights reserved|copyright|cookie policy|privacy policy|terms of use)\b/i
];
// Call-to-action furniture — drop ONLY when the line is short (a real CTA line),
// never when the word merely appears inside a longer news sentence. This avoids
// emptying legitimate stories that are *about* WhatsApp/Telegram/video/etc.
const CTA_LINE_PATTERNS = [
  /\b(contact us|call us|helpline|hotline|customer care|follow us|subscribe|newsletter|email us|download (the |our )?app|join (our|the) (telegram|whatsapp|facebook|instagram|x|twitter|linkedin)( channel| group)?)\b/i
];
const CTA_MAX_LINE_LENGTH = 80;

function isFurnitureLine(line: string): boolean {
  if (FOOTER_LINE_PATTERNS.some((p) => p.test(line))) return true;
  if (line.length <= CTA_MAX_LINE_LENGTH && CTA_LINE_PATTERNS.some((p) => p.test(line))) return true;
  return false;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&nbsp;", " ");
}

function stripHtml(text: string): string {
  return decodeEntities(String(text || ""))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function removeInlineNoise(text: string): string {
  let cleaned = text;
  for (const pattern of INLINE_NOISE_PATTERNS) cleaned = cleaned.replace(pattern, " ");
  cleaned = cleaned.replace(/https?:\/\/\S+/gi, " ");
  cleaned = cleaned.replace(/\b(?:watch|read|listen)\b\s+on\s+\b(?:youtube|spotify|apple podcasts)\b[^.?!]*/gi, " ");
  return cleaned;
}

function isMostlyPhoneLine(line: string): boolean {
  const digits = (line.match(/\d/g) || []).length;
  return digits >= 9 && /^[\d\s()+\-/,.:]+$/.test(line.trim());
}

export function cleanArticleText(text: string): string {
  // Strip CMS/agency/promo/dateline artifacts even on newline-free bodies before
  // the line-based filters run.
  const plain = removeInlineNoise(stripSourceArtifacts(stripHtml(text)))
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ");

  const lines = plain
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isFurnitureLine(line))
    .filter((line) => !isMostlyPhoneLine(line))
    .filter((line) => line.length > 20 || /[.?!]/.test(line));

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ ]{2,}/g, " ")
    .trim();
}

export function needsFullArticleFetch(text: string): boolean {
  const cleaned = cleanArticleText(text);
  if (cleaned.length < 320) return true;

  const noisySignals = [
    /\b(helpline|contact us|whatsapp|telegram|follow us|subscribe|newsletter)\b/i,
    /\+\d[\d\s()-]{7,}\d/,
    /\bprivacy policy\b/i
  ];

  return noisySignals.some((pattern) => pattern.test(text));
}

// Shared fetch used by both the text-only and title+text readers below.
// Browser-like UA: several outlets (The Hindu, Mint, …) 403 an obvious bot UA,
// which starved the og:image/fact-source fetches for those pages.
async function fetchArticleHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) throw new Error(`Article HTTP ${response.status}`);
  return await response.text();
}

// Same article/body extraction + cleanArticleText pipeline, shared so the
// text-only and title+text readers stay identical. Capped at 12000 chars.
function extractReadableText(html: string): string {
  const articleMatch = html.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
  const bodyMatch = html.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i);
  const primary = articleMatch?.[1] || bodyMatch?.[1] || html;
  return cleanArticleText(primary).slice(0, 12000);
}

// Prefer og:title, fall back to <title>. Decode entities, collapse whitespace,
// trim; null when neither tag yields anything usable.
function extractPageTitle(html: string): string | null {
  const og =
    html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["'][^>]*>/i) ??
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["'][^>]*>/i);
  let title = og?.[1] ?? "";
  if (!title) {
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    title = t?.[1] ?? "";
  }
  title = decodeEntities(title).replace(/\s+/g, " ").trim();
  return title || null;
}

// og:image (or twitter:image fallback) from a page — used to backfill a lead
// image for approved stories whose feed carried none. Null when absent.
export function extractOgImage(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
  ];
  for (const p of patterns) {
    const url = decodeEntities(html.match(p)?.[1] ?? "").trim();
    if (/^https?:\/\//i.test(url)) return url;
  }
  return null;
}

// Fetch a page and return just its og:image — the safety-net's image backfill.
export async function fetchPageOgImage(url: string): Promise<string | null> {
  return extractOgImage(await fetchArticleHtml(url));
}

// ---- NewsArticle structured data ----
// Publishers embed schema.org NewsArticle JSON-LD in article pages: headline,
// description, image, datePublished. It's the most reliable metadata on the
// page (it's what Google News reads), so prefer it over og:/meta tags. Used by
// scrape-news for section-page sources whose links carry no feed metadata.
export type ArticleMeta = {
  title: string | null;
  description: string | null;
  image: string | null;
  publishedAt: string | null;
};

function jsonLdArticle(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = jsonLdArticle(n);
      if (hit) return hit;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  const types = Array.isArray(type) ? type.map(String) : [String(type ?? "")];
  if (types.some((t) => /Article$/i.test(t) || t === "Article")) return obj;
  if (obj["@graph"]) return jsonLdArticle(obj["@graph"]);
  return null;
}

function jsonLdImage(raw: unknown): string | null {
  if (typeof raw === "string") return /^https?:\/\//i.test(raw) ? raw : null;
  if (Array.isArray(raw)) return jsonLdImage(raw[0]);
  if (raw && typeof raw === "object") return jsonLdImage((raw as Record<string, unknown>).url);
  return null;
}

export function extractArticleMeta(html: string): ArticleMeta {
  const meta: ArticleMeta = { title: null, description: null, image: null, publishedAt: null };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const article = jsonLdArticle(JSON.parse(m[1].trim()));
      if (!article) continue;
      meta.title = String(article.headline ?? "").trim() || null;
      meta.description = String(article.description ?? "").trim() || null;
      meta.image = jsonLdImage(article.image);
      meta.publishedAt = String(article.datePublished ?? "").trim() || null;
      if (meta.title) break;
    } catch {
      // malformed JSON-LD block — try the next one
    }
  }
  if (!meta.title) meta.title = extractPageTitle(html);
  if (!meta.description) {
    const d =
      html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i) ??
      html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i);
    meta.description = decodeEntities(d?.[1] ?? "").replace(/\s+/g, " ").trim() || null;
  }
  if (!meta.image) meta.image = extractOgImage(html);
  if (!meta.publishedAt) {
    const p = html.match(/<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']*)["']/i);
    meta.publishedAt = p?.[1]?.trim() || null;
  }
  return meta;
}

// Fetch an article page and return its structured metadata.
export async function fetchArticleMeta(url: string): Promise<ArticleMeta> {
  return extractArticleMeta(await fetchArticleHtml(url));
}

export async function fetchReadableArticleText(url: string): Promise<string> {
  return extractReadableText(await fetchArticleHtml(url));
}

// Like fetchReadableArticleText, but also extracts the page title. Reuses the
// exact same fetch + extraction + cleanArticleText pipeline.
export async function fetchReadablePage(url: string): Promise<{ title: string | null; text: string }> {
  const html = await fetchArticleHtml(url);
  return { title: extractPageTitle(html), text: extractReadableText(html) };
}
