// _shared/editorial-case.ts
// The source-bound case-study writer, extracted verbatim from
// editorial-topic-agent so generate-from-url can build a case study from a
// QA-pasted link with the exact same prompts, structure bar, repair pass and
// safety enforcement. Pure move — no behavior change.

import { chatCompletionRaw } from "./summary-clean.ts";
import type { EditorialTopic } from "./editorial-topics.ts";

export type CaseCandidate = {
  title: string;
  url: string;
  source: string;
  excerpt?: string;
};

export type RankedCandidate = {
  url: string;
  angle?: string;
  selection_reason?: string;
};

export async function buildCaseRow(
  apiKey: string,
  model: string,
  topic: EditorialTopic,
  candidate: CaseCandidate,
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

export async function writeCase(
  apiKey: string,
  model: string,
  topic: EditorialTopic,
  candidate: CaseCandidate,
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

export async function repairCase(
  apiKey: string,
  model: string,
  topic: EditorialTopic,
  candidate: CaseCandidate,
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

export function enforceSafety(topic: EditorialTopic, draft: Record<string, any>): Record<string, any> {
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

export function draftMeetsStructure(topic: EditorialTopic, draft: Record<string, any>): boolean {
  return validationReport(topic, draft).length === 0;
}

// Relaxed bar for the never-empty fallback: shorter is OK, but it must still carry
// a usable summary + some analysis (source-bound) and the required safety lines.
export function draftMeetsRelaxed(topic: EditorialTopic, draft: Record<string, any>): boolean {
  const summaryWords = words(draft.summary);
  const detailWords = words(draft.detail);
  if (summaryWords < 50 || detailWords < 120) return false;
  if (!String(draft.headline ?? "").trim()) return false;
  if (topic.slug === "markets-startups" && !String(draft.detail ?? "").includes("SEBI-registered advisor")) return false;
  return true;
}

export function validationReport(topic: EditorialTopic, draft: Record<string, any>): string[] {
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

export function words(value: unknown): number {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

export function indiaDateLabel(): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date());
}

export async function openAiJson(apiKey: string, model: string, system: string, user: string, maxTokens: number): Promise<Record<string, any>> {
  // chatCompletionRaw retries on 429 (low tokens-per-minute account) and surfaces
  // clear quota/auth errors.
  const raw = await chatCompletionRaw(apiKey, model, system, user, maxTokens, { jsonMode: true, temperature: 0.2 });
  return JSON.parse(raw);
}
