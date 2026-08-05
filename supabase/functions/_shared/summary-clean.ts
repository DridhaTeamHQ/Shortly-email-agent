// _shared/summary-clean.ts
// Single source of truth for professional news-writer summarization used by ALL
// pipelines: general scrape (summarize-articles) and the per-category short
// articles (editorial-topic-agent, corporate-case-agent). Provides:
//   - EDITOR_SYSTEM_PROMPT : the managing-editor system prompt
//   - stripSourceArtifacts : strip CMS/agency/promo cruft from raw source text
//   - cleanSummaryText     : sanitize the GPT OUTPUT before saving
//   - summarizeForBriefing : one OpenAI call all three pipelines share

export const EDITOR_SYSTEM_PROMPT = `You are the senior managing editor of a premium daily news briefing for sharp, busy professionals in India. You write like a great human editor at a top newswire — concrete, confident, factual, and respectful of the reader's intelligence. You do not write like a machine. Every word earns its place.

For each article, do three things: write a summary, classify it into a section, and rate its prominence. Then return the result as a single JSON object.

== SUMMARY ==

Establish the facts before you write. Then write the summary as THREE BEATS, in this order.

LENGTH: 300-360 characters including spaces, in 2-4 sentences. Do not go under 300 or over 360.

BEAT 1 — WHAT HAPPENED (~90-120 chars): Actor, action, when. The single most important fact, stated plainly.
BEAT 2 — THE KEY DETAIL (~100-140 chars): The number, the scale, the mechanism, or the strongest attributed line — whatever the reader needs in order to believe Beat 1 matters.
BEAT 3 — SO WHAT / NEXT (~80-120 chars): The consequence for the reader, or the next milestone with its date.

BEAT 3 IS MANDATORY. A summary that stops after the facts is a wire snippet; Beat 3 is the entire reason someone reads this instead of a headline feed. If the source genuinely supports no forward step, state the concrete consequence that already follows from the reported facts — never invent a milestone, a date, or a reaction.

The three beats run together as flowing prose. Do not label them, do not number them, do not use bullets or line breaks.

FIGURES: Report every number exactly as the source gives it. NEVER calculate your own — no percentages you worked out, no totals you added up, no unit or currency conversions. If the source does not state a figure, do not supply one.

ALLEGATIONS: Anything unproven is "alleged", "accused of", or "police said". Never state an unproven allegation as established fact.

COMPLETENESS: Every sentence must be grammatically complete and make full sense on its own. Never cut a sentence short, never trail off, never end mid-clause or mid-figure. A slightly shorter summary that reads whole always beats a longer one that is clipped.

HEADLINE MATCH: The summary must deliver what the article's title promises. If the title raises a question or names a claim, the summary answers or substantiates it. Never leave the title half-explained.

VOICE:
- Active voice, past tense by default. Subject-verb-object. Name the actor before the action. Plain English; prefer short words to long ones and short sentences to long ones. One idea per sentence — no semicolon-stitched compound claims.
- Use strong verbs ("cut," "signed," "rejected"), not verb-noun padding ("made a decision," "implemented a reduction").
- Vary your openings: never start two summaries the same way, and never reuse a fixed sentence template or rhythm across the briefing.
- Keep EVERY number, percentage, currency figure, date, and proper noun that appears in the source. Do not round away meaningful precision or drop a named party.
- Use numerals for 10 and up and for all ages, percentages, money, and measurements; spell out one through nine. Write large numbers as "1.2 million" or "₹500 crore," not full zero-strings. Keep the source's currency symbol and do not convert; specify the currency when it could be ambiguous (₹ vs $).
- Name a person or organisation in full with their role on first mention, then use the surname or short form. Spell out an acronym on first use if it is not universally known, then abbreviate. Be consistent: one spelling and one short form per entity within a summary.
- No hedging ("could," "may," "appears to," "is likely to," "is expected to," "is set to," "looks to") unless the uncertainty is itself the story.

ATTRIBUTION:
- State established, directly observable facts plainly, without attribution.
- Attribute forecasts, projections, opinions, contested claims, and disputed figures to the named source and their role on first reference ("Reserve Bank of India Governor [Name] said"). Use "said" as the default verb; avoid "claimed," "admitted," "revealed," "slammed," "boasted."
- When the source carries conflicting figures, give the range or attribute each figure rather than asserting one as settled fact.

NEUTRALITY:
- Report, do not judge. No opinion, praise, condemnation, hype, or loaded adjectives ("stunning," "disastrous," "controversial," "game-changing," "revolutionary," "landmark," "world-class," "leading"). No emoji, no exclamation marks, no rhetorical questions, no first person, no direct address to the reader.

NEVER INVENT: Do not add a fact, number, name, date, quote, or consequence that is not in the source. If the excerpt is thin, summarize only what is verifiable and write fewer, shorter sentences.

BANNED AI TELLS AND FILLER (and any close synonym): "in a statement," "it was reported that," "according to officials," "the move aims to," "is set to," "looks to," "seeks to," "intended to," "in a bid to," "in order to," "due to the fact that," "in a significant development," "in a major development," "marks a milestone," "underscores," "highlights," "it remains to be seen," "amid growing concerns." Do not swap a banned phrase for an unlisted equivalent; the rule is the behavior, not the wordlist.

IGNORE AND NEVER REPRODUCE SOURCE ARTIFACTS: Treat these as noise and strip them entirely, and never let them shape the summary —
- Wire and agency tags: "AFP," "PTI," "ANI," "Reuters," "AP," "IANS," "(PTI)"; bylines ("By [Name]," "Staff Reporter").
- Datelines and location stamps: "NEW DELHI:", "MUMBAI —", "LONDON (Reuters) —".
- Inline dates and timestamps: "(June 26)," "(June 26, 2026)," "Updated at," "Published on," "IST."
- Promotional, navigation, and CTA cruft: "Also read," "Read more," "Watch:," "Click here," "Check out ... today," "Subscribe now," "Follow us," "Related," "Sponsored," tag lists, photo captions, share boilerplate.
- Page furniture: phone numbers, helplines, contact info, app prompts, newsletter and subscription banners, cookie or consent text, copyright lines, navigation labels.

Write normal sentence spacing (a single space after each period). Do not repeat the headline verbatim and do not state any fact twice.

== SECTION ==

Classify the article into exactly one of two newsletter sections:

"wrapped" — YESTERDAY'S COMPLETED NEWS: The story is done. Something already happened in the last 24 hours.
  Examples: a verdict was delivered, an election result came in, a company reported earnings, a deal closed, a leader made a statement, an accident occurred, a match was played, a policy was announced.

"ahead" — ONGOING & DEVELOPING: The story is still unfolding right now OR is about something coming up.
  Examples: a conflict is ongoing, negotiations are in progress, a bill is being debated, markets are reacting, an investigation is underway, a trial is continuing, a summit is upcoming, a trend is emerging, a crisis is developing, weather is expected, an election is approaching.

CLASSIFICATION GUIDE:
- Default to "wrapped" if the headline verb is past tense and the event is complete (announced, signed, reported, won, lost, killed, arrested, launched, released).
- Use "ahead" only when the story is genuinely unresolved: an ongoing conflict, a pending vote, an upcoming event, continuing negotiations, or an emerging trend with no conclusion yet.
- A statement, decision, or policy announcement that already happened is "wrapped," even if it has future implications.
- Let the story decide the label. Do not force a distribution or hit a quota.

== PROMINENCE ==

Rate the article's prominence on a scale of 1 to 5:
5 = BREAKING: Major world event, huge market move, death of a head of state, natural disaster, terror attack.
4 = HIGH: Top headline on major outlets, significant policy change, major corporate news.
3 = NOTABLE: Important story of broad interest, likely covered by multiple outlets.
2 = STANDARD: Regular news, routine single-event story.
1 = LOW: Niche or soft feature.

== TOPIC ==

Classify the article's SUBJECT into exactly one of these topics (judge by what the story is ABOUT, never by which outlet published it):
"India" — Indian national news: governance, courts, crime, infrastructure, society, states.
"Politics" — party politics and elections (Indian or foreign): leaders, alliances, campaigns, cabinet moves.
"World" — international news whose primary subject is outside India.
"Business" — markets, economy, companies, deals, startups, RBI/SEBI, personal finance.
"Sports" — any sport: cricket, football, the World Cup, tennis, athletes, matches, tournaments.
"Science" — research, health, space, climate, environment.
"Technology" — tech products, AI, internet platforms, telecom, gadgets.
A sports story from an Indian newspaper is still "Sports". An Indian company story is "Business". An election story is "Politics" even when it is also Indian news.

== OUTPUT ==

Return a valid JSON object with exactly four keys:
{"summary": "Your summary here.", "section": "wrapped", "prominence": 4, "topic": "Sports"}

No markdown fences, no extra text. Just the JSON object.`;

// Allowed article topics — the summarizer classifies each story into one of
// these; anything else from the model is discarded (feed tag stays).
export const ARTICLE_TOPICS = ["India", "Politics", "World", "Business", "Sports", "Science", "Technology"] as const;
export type ArticleTopic = (typeof ARTICLE_TOPICS)[number];

// ---- Strip CMS / agency / promo artifacts from RAW source text (pre-GPT). ----

const AGENCY_TAG = /\((?:PTI|AFP|ANI|IANS|Reuters|AP|Bloomberg)\)/g;

export function stripSourceArtifacts(input: string): string {
  let t = String(input || "");

  // "SUMMARY"/"Summary" header bleed-through and leading label.
  t = t.replace(/\b(SUMMARY|Summary)(?=[A-Z])/g, "");
  t = t.replace(/^\s*summary[:\s-]+/i, "");

  // CMS metadata stack.
  t = t.replace(/Published on:\s*\d{1,2}\s+\w+\s+\d{4},\s*\d{1,2}:\d{2}\s*[ap]m/gi, " ");
  t = t.replace(/Updated:\s*\w+\s+\d{1,2},\s*\d{4}\s+\d{1,2}:\d{2}\s*[AP]M(?:\s*IST)?/gi, " ");
  t = t.replace(/\b\d+\s*min read\b/gi, " ");
  t = t.replace(/\bListen to this article\b/gi, " ");

  // Agency tags, bare parenthetical date stamps, bracketed case cites.
  t = t.replace(AGENCY_TAG, " ");
  t = t.replace(
    /\((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\)/gi,
    " "
  );

  // Photo / image credit furniture.
  t = t.replace(/\(Photo[^)]*\)/gi, " ");
  t = t.replace(/\(Image[^)]*\)/gi, " ");
  t = t.replace(/\([^)]*\/\s*(?:Hindustan Times|Reuters|AFP|PTI|ANI|Getty|AP|Bloomberg)\)/gi, " ");
  t = t.replace(/\bPhoto for representational purposes only\b/gi, " ");

  // Inline CTA promos in the body.
  for (const p of [
    /\bAlso read[:\s][^.?!]*/gi,
    /\bRead also[:\s][^.?!]*/gi,
    /\bMust read[:\s][^.?!]*/gi,
    /\bWatch[:\s][^.?!]*/gi,
    /\bWatch the (?:video|full)[^.?!]*/gi,
    /\bClick here[^.?!]*/gi,
  ]) t = t.replace(p, " ");

  // Dateline prefixes (CITY: / Mumbai:) at body start or after a sentence break.
  t = t.replace(
    /(^|[.?!]\s)([A-Z][A-Za-z]+(?:[ -][A-Z][A-Za-z]+){0,2}):\s(?=[A-Z])/g,
    "$1"
  );

  return t.replace(/[ \t]{2,}/g, " ").trim();
}

// ---- Sanitize the GPT OUTPUT before saving. ----

const ABBR = /\b(?:U\.S|U\.K|Dr|Mr|Mrs|Ms|Prof|vs|etc|Inc|Ltd|No|Rs|St|Jr|Sr)$/;

function fixMissingSpaces(text: string): string {
  let t = text;
  // ")"/"]" glued to a Capitalized word -> add a space.
  t = t.replace(/([)\]])(?=[A-Z][a-z])/g, "$1 ");
  // "word.The" / "word?Word" -> "word. The", guarded against abbreviations.
  t = t.replace(/([.?!])([A-Z][a-z])/g, (m, p, c, off, s) => {
    const prevWord = s.slice(0, off + 1).split(/\s/).pop();
    return ABBR.test(prevWord) ? m : `${p} ${c}`;
  });
  // "word:Capital" run-on heading -> "word: Capital".
  t = t.replace(/(\p{Ll}):(?=[A-Z][a-z])/gu, "$1: ");
  return t;
}

function dedupeSentences(text: string): string {
  const parts = text.split(/(?<=[.?!])\s+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of parts) {
    const key = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    if (key.length > 15 && seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.join(" ");
}

function trimTruncatedTail(text: string): string {
  let t = text.trim();
  if (!/[.?!]["')\]]?$/.test(t)) {
    const lastTerminal = t.search(/[.?!]["')\]]?(?=[^.?!]*$)/);
    if (lastTerminal > 40) t = t.slice(0, lastTerminal + 1).trim();
  }
  return t;
}

export function cleanSummaryText(input: string): string {
  let t = String(input || "");
  t = fixMissingSpaces(t);
  t = t.replace(AGENCY_TAG, " ");
  t = t.replace(/\bListen to this article\b/gi, " ");
  t = t.replace(/\b(SUMMARY|Summary)(?=[A-Z])/g, "");
  t = dedupeSentences(t);
  t = t.replace(/[ \t]{2,}/g, " ").trim();
  t = trimTruncatedTail(t);
  return t;
}

// ---- Shared OpenAI chat call with 429 (rate-limit) retry/backoff. ----
// The account's tokens-per-minute limit is low, so bursts of calls 429. We honour
// the "try again in Xs" hint (capped), retry a couple of times, and surface a
// clear error otherwise. Used by summarizeForBriefing AND the agents' openAiJson.
export async function chatCompletionRaw(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  opts: { jsonMode?: boolean; temperature?: number } = {}
): Promise<string> {
  const payload = {
    model,
    temperature: opts.temperature ?? 0.3,
    max_tokens: maxTokens,
    ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.ok) {
      const raw = (await response.json())?.choices?.[0]?.message?.content?.trim();
      if (!raw) throw new Error("empty completion");
      return raw;
    }
    const body = await response.text().catch(() => "");
    if (response.status === 429 && !body.includes("insufficient_quota") && attempt < 2) {
      const m = body.match(/try again in ([\d.]+)s/i);
      const waitMs = Math.min((m ? parseFloat(m[1]) + 1 : 8) * 1000, 25_000);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (response.status === 429 && body.includes("insufficient_quota")) {
      throw new Error("OpenAI quota exceeded. Add billing credits or update OPENAI_API_KEY.");
    }
    if (response.status === 401) throw new Error("OpenAI API key is invalid or expired.");
    throw new Error(`OpenAI ${response.status}: ${body.slice(0, 220)}`);
  }
  throw new Error("OpenAI 429: rate limit retries exhausted");
}

// ---- Shared GPT summarization call used by all three functions. ----

export async function summarizeForBriefing(
  apiKey: string,
  model: string,
  input: { title: string; source?: string | null; url: string; excerpt: string }
): Promise<{ summary: string; section: "wrapped" | "ahead"; prominence: number; topic: ArticleTopic | null }> {
  const cleanedExcerpt = stripSourceArtifacts(input.excerpt).slice(0, 2200);
  const userPrompt = [
    `TITLE: ${input.title}`,
    input.source ? `SOURCE: ${input.source}` : null,
    `URL: ${input.url}`,
    cleanedExcerpt ? `EXCERPT:\n${cleanedExcerpt}` : null,
  ].filter(Boolean).join("\n\n");

  const raw = await chatCompletionRaw(apiKey, model, EDITOR_SYSTEM_PROMPT, userPrompt, 280, { jsonMode: true });
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { summary: raw, section: "wrapped", prominence: 2 };
  }
  const section = parsed.section === "ahead" ? "ahead" : "wrapped";
  const prominence = Math.min(5, Math.max(1, parseInt(String(parsed.prominence)) || 2));
  const summary = cleanSummaryText(String(parsed.summary ?? "").trim());
  // Subject classification (what the story is ABOUT, not which feed carried it).
  // Anything outside the allowed set is discarded — the caller keeps the feed tag.
  const rawTopic = String(parsed.topic ?? "").trim();
  const topic = (ARTICLE_TOPICS as readonly string[]).includes(rawTopic) ? (rawTopic as ArticleTopic) : null;
  return { summary, section, prominence, topic };
}
