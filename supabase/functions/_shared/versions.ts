// _shared/versions.ts
// Reader-facing alternate versions of an approved article, generated ONCE at
// approval time (review-article for short articles, editorial-topic-agent for
// long reads) and stored in the `versions` jsonb column. The website reader
// offers them as a toggle: Original | ELI5 | TL;DR | Deep dive | Key numbers.
//
// One cheap-model JSON call produces all four renditions together — that is
// 4x cheaper and faster than four calls, and keeps every version derived from
// the SAME grounded material. Same never-invent rule as the summarizer: every
// version may only restate facts present in the supplied text.
//
// Cost: one gpt-4o-mini call (~900 output tokens) per approval — approvals are
// a small fraction of scraped articles, so this is cheaper than scoring at
// scrape time. Failure is non-fatal (versions stay null; the website simply
// shows only the original). Kill-switch: VERSIONS_ENABLED=false.

import { chatCompletionRaw, stripSourceArtifacts } from "./summary-clean.ts";

export type ArticleVersions = {
  eli5: string;
  tldr: string[];
  deep_dive: string;
  key_numbers: string[];
  generated_at: string;
};

const VERSIONS_SYSTEM_PROMPT = `You are the senior rewrite editor of a premium news product. You re-render one approved news article into four alternate versions for different reading moods. You NEVER add a fact, number, name, date, or consequence that is not in the supplied material — every version is a re-expression of the same verified content. If the material is thin, versions are simply shorter; never pad, never speculate.

Produce ALL FOUR:

1. "eli5" — Explain Like I'm 5. 3-4 short, warm sentences a curious child could follow. Everyday words and one simple analogy drawn from daily life (pocket money, toys, school, kitchen). No jargon, no numbers with more than two digits unless essential (round them: "about 500").

2. "tldr" — 60-second TL;DR. An array of exactly 2-3 bullet strings, each under 20 words, plain and punchy. First bullet = what happened; second = why it matters; optional third = what's next (only if the material supports it).

3. "deep_dive" — Deep dive. 150-220 words in 2-3 paragraphs separated by a blank line (\\n\\n). Reconstruct the fullest picture the material supports: the event, the mechanics behind it, the context the material itself gives, and the stated consequences. Same sober newswire register as the original. Do NOT import outside background — depth comes from using ALL of the supplied material, not from invention.

4. "key_numbers" — Key numbers & takeaways. An array of 3-6 bullet strings. Lead with every concrete figure, date, and named actor in the material ("₹500 crore — size of the fund", "March 2027 — completion deadline"), then finish with 1-2 plain-language takeaways. If the material has no numbers, give named actors and dated milestones instead.

OUTPUT: one JSON object, no markdown fences:
{"eli5":"...","tldr":["...","..."],"deep_dive":"...","key_numbers":["...","..."]}`;

function cleanStringArray(value: unknown, max: number): string[] {
  return (Array.isArray(value) ? value : [])
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .slice(0, max);
}

export function versionsEnabled(): boolean {
  return (Deno.env.get("VERSIONS_ENABLED") ?? "true").toLowerCase() !== "false";
}

function versionsModel(): string {
  return Deno.env.get("VERSIONS_MODEL") ?? Deno.env.get("SUMMARIZE_MODEL") ?? "gpt-4o-mini";
}

// Returns null (never throws) when disabled or on any model/parse failure —
// the approval itself must never fail because a rewrite did.
export async function generateArticleVersions(
  apiKey: string,
  input: { headline: string; body: string; sourceText?: string }
): Promise<ArticleVersions | null> {
  if (!versionsEnabled()) return null;
  const headline = String(input.headline || "").trim();
  const body = String(input.body || "").trim();
  if (!headline || !body) return null;
  // Extra source material lets deep_dive use detail the summary dropped.
  const extra = stripSourceArtifacts(String(input.sourceText || "")).slice(0, 2800);

  const userPrompt = [
    `HEADLINE: ${headline}`,
    `ARTICLE:\n${body}`,
    extra && extra.length > body.length ? `FULL SOURCE MATERIAL (same story, use for depth):\n${extra}` : null,
  ].filter(Boolean).join("\n\n");

  try {
    const raw = await chatCompletionRaw(apiKey, versionsModel(), VERSIONS_SYSTEM_PROMPT, userPrompt, 900, {
      jsonMode: true,
      temperature: 0.4,
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const eli5 = String(parsed.eli5 ?? "").trim();
    const tldr = cleanStringArray(parsed.tldr, 3);
    const deepDive = String(parsed.deep_dive ?? "").trim();
    const keyNumbers = cleanStringArray(parsed.key_numbers, 6);
    if (!eli5 && tldr.length === 0 && !deepDive && keyNumbers.length === 0) return null;
    return {
      eli5,
      tldr,
      deep_dive: deepDive,
      key_numbers: keyNumbers,
      generated_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
