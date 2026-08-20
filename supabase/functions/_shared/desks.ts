// _shared/desks.ts
// The editorial guarantee: every wrap carries one finance story and one tech
// story, politics may take up to three of the five slots, and the finance story
// is an INDIA business story rather than a market ticker.
//
// WHY THIS FILE EXISTS
// An article has to survive four independent gates to reach the email:
//
//   scrape-news        top ~120 new items   ordered by rank_score
//   summarize-articles top 30 pending       ordered by rank_score
//   auto-curate        daily approve quota  ordered by rank_score
//   send-newsletter    five wrap slots      ordered by strength()
//
// Every one of them ranks on rank_score, and rank_score starts as
// source.weight x qualityScore. The tech feeds carry the lowest weights in the
// registry (avg 0.78, against 0.93 for India and 0.90 for Politics) and there
// are only four of them against fourteen India feeds. The result measured on
// 2026-08-18: all six tech/science sources fetching cleanly, zero failures --
// and 1 tech article in three days, 0 in the last scrape.
//
// So a mandatory tech slot in the wrap alone would be theatre: the slot would
// be empty because nothing tech ever reaches the pool. Each gate reserves a
// floor for these desks instead, and the wrap makes the final guarantee.
//
// Topic strings come from sources.topic in the registry, so they are a small
// closed set, not free text.

export type Desk = "finance" | "tech";

// Ordered by preference: a desk is filled from its first topic that has
// anything available. Science is a deliberate fallback for tech -- "The Hindu
// Sci-Tech" files under Science and is the same beat -- but a real Technology
// story always wins.
export const DESK_TOPICS: Record<Desk, string[]> = {
  finance: ["Business"],
  tech: ["Technology", "Science"],
};

export const DESKS: Desk[] = ["finance", "tech"];

const norm = (t: string | null | undefined) => (t ?? "").trim();

export function isDesk(desk: Desk, topic: string | null | undefined): boolean {
  return DESK_TOPICS[desk].includes(norm(topic));
}

export function deskOf(topic: string | null | undefined): Desk | null {
  for (const d of DESKS) if (isDesk(d, topic)) return d;
  return null;
}

// Every topic that counts toward a desk, flattened. Used by the ingest stages
// to build a reserved bucket in one pass.
export const DESK_TOPIC_LIST: string[] = [...new Set(DESKS.flatMap((d) => DESK_TOPICS[d]))];

// Politics is allowed three of five slots; every other topic stays at the
// normal cap. Stated here so the wrap and any future consumer agree.
export const POLITICS_TOPIC = "Politics";

// ---- which finance story, not just any finance story ------------------------
//
// The desk guarantee fills its slot from the Business pool, and strength()
// knows nothing about what makes a business story worth a reader's morning. On
// 2026-08-19 the approved pool held "RBI to step up push for rupee
// internationalisation", "Centre clears 31 more applications under electronics
// manufacturing" and "India's economic growth to slow to 6.8% FY27" -- and the
// slot went to "Rupee rises 1 paisa to 95.73 in early trade".
//
// The brief: a business update relevant to India -- policy, regulators,
// companies, the economy -- not a market ticker, and not a foreign company's
// share price.

// India is the subject, or an Indian institution is. Checked across headline
// AND summary, because relevance can be established anywhere in the story.
const INDIA_BUSINESS =
  /\b(india|indian|rbi|sebi|irdai|trai|niti aayog|new delhi|centre|union (budget|cabinet|government)|finance ministry|gst|adani|ambani|reliance|tata|infosys|hdfc|icici|sbi)\b/i;

// A price moved. Checked against the HEADLINE only: being a market update is a
// claim the headline makes, and testing the summary too demoted real policy
// stories over a passing mention -- "Xiaomi bets on premium phones" and
// "India's outward FDI jumps 17%" both lost their India credit that way.
//
// Spelled out at length on purpose. The first version was terse and leaked:
// "Rupee rises 1 paisa" survived because it matched only the plural "paise",
// and "Stock markets decline" survived because the pattern expected the verb
// adjacent to the noun, with no room for "markets" in between.
const MOVE =
  "(rise|rises|rose|rising|fall|falls|fell|falling|decline|declines|declined" +
  "|gain|gains|gained|slip|slips|slipped|drop|drops|dropped|climb|climbs|climbed" +
  "|surge|surges|surged|skyrocket|skyrockets|soar|soars|soared|tumble|tumbles|tumbled" +
  "|jump|jumps|jumped|plunge|plunges|plunged|rally|rallies|rallied|end|ends|ended" +
  "|close|closes|closed|open|opens|opened|sink|sinks|sank|crash|crashes|crashed" +
  "|weaken|weakens|weakened|strengthen|strengthens|strengthened)";

const MARKET_TICKER = new RegExp([
  String.raw`\b(sensex|nifty|bourses|dalal street|equity benchmark|benchmark indices)\b`,
  String.raw`\b(stock|stocks|share|shares|equity|equities|market|markets)\b[^.]{0,40}\b` + MOVE + String.raw`\b`,
  String.raw`\brupee\b[^.]{0,40}\b` + MOVE + String.raw`\b`,
  String.raw`\b\d+\s*(paisa|paise|basis points|bps|points)\b`,
  String.raw`\bin (early|late|opening|closing) trade\b`,
  String.raw`\b(52-week|all-time)\s+(high|low)\b`,
  String.raw`\bmarket cap`,
].join("|"), "i");

/**
 * Preference score for filling a desk slot. Higher wins; ties keep the existing
 * strength order, so this RE-RANKS without overriding editorial judgement.
 *
 * Verified against the live Business pool on 2026-08-19: nine India policy,
 * regulator and company stories scored 2; the two rupee tickers dropped to 0;
 * "SpaceX shares skyrocket" and "Markets fall in early trade" to -2.
 */
export function deskPreference(desk: Desk, title: string, summary?: string | null): number {
  if (desk !== "finance") return 0;
  let score = 0;
  if (INDIA_BUSINESS.test(`${title} ${summary ?? ""}`)) score += 2;
  if (MARKET_TICKER.test(title)) score -= 2;
  return score;
}
