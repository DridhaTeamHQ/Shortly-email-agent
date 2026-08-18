// _shared/desks.ts
// The editorial guarantee: every wrap carries one finance story and one tech
// story, and politics may take up to three of the five slots.
//
// WHY THIS FILE EXISTS
// An article has to survive four independent gates to reach the email:
//
//   scrape-news       top ~120 new items   ordered by rank_score
//   summarize-articles top 30 pending      ordered by rank_score
//   auto-curate        daily approve quota ordered by rank_score
//   send-newsletter    five wrap slots     ordered by strength()
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
