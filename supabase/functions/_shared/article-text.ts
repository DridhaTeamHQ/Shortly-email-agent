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
  const plain = removeInlineNoise(stripHtml(text))
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

export async function fetchReadableArticleText(url: string): Promise<string> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ShortlyScraper/1.0)" }
  });
  if (!response.ok) throw new Error(`Article HTTP ${response.status}`);

  const html = await response.text();
  const articleMatch = html.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
  const bodyMatch = html.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i);
  const primary = articleMatch?.[1] || bodyMatch?.[1] || html;
  return cleanArticleText(primary).slice(0, 12000);
}
