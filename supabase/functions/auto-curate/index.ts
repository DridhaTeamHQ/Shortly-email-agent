// auto-curate: the daily "auto-pilot". Automatically approves a target quota of
// content so the site + newsletter always have a baseline, WITHOUT waiting for a
// human. QA can still review/reject/add on top — this only guarantees the floor.
//
// Daily quotas (all env-overridable):
//   AUTO_TOPICS         = 6   trending topics (top by score; publishes members)
//   AUTO_GENERAL        = 50  General articles (top rank, EXCLUDING topic members)
//   AUTO_CAT_ARTICLES   = 10  short articles PER category
//   AUTO_CAT_CASES      = 2   case studies PER category
//   AUTO_STALE_DRAFT_DAYS = 3 reject un-approved case drafts older than this
//
// Quotas are per-IST-day and idempotent: it counts what today already approved
// and only tops up the remainder, so running it twice never double-approves.
// General + topics quotas are PRO-RATED by 6-hour cycle (ceil(base*cycle/4)),
// so with the 4-cycles/day crons each cycle publishes its share instead of the
// morning run exhausting the whole day's quota.
// No OpenAI spend — this is pure selection/approval over already-generated
// content. Reader versions for auto-approved General articles are filled in by
// the fact safety-net cron shortly after (same as any approval).
//
// ANON-callable (verify_jwt gateway); uses the service-role client internally,
// like scrape-news / trending-topics.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { requireAgent } from "../_shared/agent-auth.ts";

const SHORT_CATEGORIES = ["Real Estate", "Automobile", "Health & Wellness", "Tech & AI", "Markets & Startups"];
const CATEGORY_SLUG: Record<string, string> = {
  "Real Estate": "real-estate",
  "Automobile": "automobile",
  "Health & Wellness": "health-wellness",
  "Tech & AI": "tech-ai",
  "Markets & Startups": "markets-startups",
};

const REVIEWER = "ai-auto";

function intEnv(name: string, fallback: number): number {
  const v = Number(Deno.env.get(name));
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

// Start of the current IST day, as an ISO timestamp (for "already approved today"
// counts). Mirrors the window used by list-articles.
function istDayStart(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const val = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const startMs = Date.UTC(val("year"), val("month") - 1, val("day")) - (5.5 * 60 * 60 * 1000);
  return new Date(startMs).toISOString();
}

// Which 6-hour cycle of the IST day we're in (1..4). Quotas for General and
// topics are pro-rated by cycle (ceil(base * cycle/4)) so the morning run
// can't exhaust the whole day's quota — every cycle gets to publish its share
// and the site refreshes through the day.
function istCycle(): number {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false })
      .formatToParts(new Date()).find((p) => p.type === "hour")?.value
  );
  return Math.min(4, Math.floor((Number.isFinite(hour) ? hour : 0) / 6) + 1);
}

function proRata(base: number, cycle: number): number {
  return Math.ceil((base * cycle) / 4);
}

async function countApprovedToday(supabase: any, dayStart: string, filter: (q: any) => any): Promise<number> {
  let q = supabase.from("articles").select("id", { count: "exact", head: true })
    .eq("status", "approved").gte("reviewed_at", dayStart);
  q = filter(q);
  const { count } = await q;
  return count ?? 0;
}

async function handle(supabase: any): Promise<Response> {
  const quotas = {
    topics: intEnv("AUTO_TOPICS", 6),
    general: intEnv("AUTO_GENERAL", 50),
    catArticles: intEnv("AUTO_CAT_ARTICLES", 10),
    catCases: intEnv("AUTO_CAT_CASES", 2),
    staleDays: intEnv("AUTO_STALE_DRAFT_DAYS", 3),
  };
  const dayStart = istDayStart();
  const cycle = istCycle();
  const nowIso = new Date().toISOString();
  const result: Record<string, unknown> = { cycle };

  // ---- 1. TRENDING TOPICS: approve the top suggested topics by score. ----
  // Approving a topic also promotes its still-summarized member articles to
  // approved (mirrors trending-topics' approve), so the timeline publishes.
  let topicsApproved = 0;
  const { count: topicsApprovedToday } = await supabase
    .from("topics").select("id", { count: "exact", head: true })
    .eq("status", "approved").eq("reviewed_by", REVIEWER).gte("approved_at", dayStart);
  const topicNeed = Math.max(0, proRata(quotas.topics, cycle) - (topicsApprovedToday ?? 0));
  const { data: suggestedTopics } = await supabase
    .from("topics").select("id").eq("status", "suggested")
    .order("score", { ascending: false }).limit(topicNeed);
  for (const t of (suggestedTopics ?? [])) {
    const { error } = await supabase.from("topics")
      .update({ status: "approved", approved_at: nowIso, reviewed_at: nowIso, reviewed_by: REVIEWER })
      .eq("id", t.id);
    if (error) continue;
    const { data: links } = await supabase.from("topic_articles").select("article_id").eq("topic_id", t.id);
    const memberIds = (links ?? []).map((l: any) => l.article_id);
    if (memberIds.length) {
      await supabase.from("articles")
        .update({ status: "approved", reviewed_at: nowIso, reviewed_by: REVIEWER })
        .in("id", memberIds).eq("status", "summarized");
    }
    topicsApproved++;
  }
  result.topics = topicsApproved;

  // Article ids that belong to ANY approved topic — the General quota is
  // "apart from the trending topic articles", so we exclude these.
  const { data: approvedTopicRows } = await supabase.from("topics").select("id").eq("status", "approved");
  const approvedTopicIds = (approvedTopicRows ?? []).map((r: any) => r.id);
  const topicMemberIds = new Set<string>();
  if (approvedTopicIds.length) {
    const { data: memberLinks } = await supabase.from("topic_articles").select("article_id").in("topic_id", approvedTopicIds);
    for (const m of (memberLinks ?? [])) topicMemberIds.add(m.article_id);
  }

  // ---- 2. GENERAL: top up to AUTO_GENERAL, excluding topic members. ----
  const generalApprovedToday = await countApprovedToday(supabase, dayStart, (q) => q.is("category", null));
  const generalNeed = Math.max(0, proRata(quotas.general, cycle) - generalApprovedToday);
  let generalApproved = 0;
  if (generalNeed > 0) {
    // Pull a generous candidate window (recent summarized General), then filter
    // out topic members in code and take the top `need` by rank.
    const { data: cands } = await supabase.from("articles")
      .select("id,rank_score")
      .is("category", null).eq("status", "summarized")
      .order("rank_score", { ascending: false, nullsFirst: false })
      .limit(generalNeed + topicMemberIds.size + 20);
    const pick = (cands ?? []).filter((a: any) => !topicMemberIds.has(a.id)).slice(0, generalNeed).map((a: any) => a.id);
    if (pick.length) {
      const { data: upd } = await supabase.from("articles")
        .update({ status: "approved", reviewed_at: nowIso, reviewed_by: REVIEWER })
        .in("id", pick).eq("status", "summarized").select("id");
      generalApproved = (upd ?? []).length;
    }
  }
  result.general = generalApproved;

  // ---- 3. PER CATEGORY: top up short articles + case studies. ----
  const byCategory: Record<string, { articles: number; cases: number }> = {};
  for (const cat of SHORT_CATEGORIES) {
    // Short articles
    const catApprovedToday = await countApprovedToday(supabase, dayStart, (q) => q.eq("category", cat));
    const artNeed = Math.max(0, quotas.catArticles - catApprovedToday);
    let artApproved = 0;
    if (artNeed > 0) {
      const { data: cands } = await supabase.from("articles")
        .select("id").eq("category", cat).eq("status", "summarized")
        .order("rank_score", { ascending: false, nullsFirst: false }).limit(artNeed);
      const ids = (cands ?? []).map((a: any) => a.id);
      if (ids.length) {
        const { data: upd } = await supabase.from("articles")
          .update({ status: "approved", reviewed_at: nowIso, reviewed_by: REVIEWER })
          .in("id", ids).eq("status", "summarized").select("id");
        artApproved = (upd ?? []).length;
      }
    }

    // Case studies (editorial_drafts)
    const slug = CATEGORY_SLUG[cat];
    const { count: casesApprovedToday } = await supabase.from("editorial_drafts")
      .select("id", { count: "exact", head: true })
      .eq("topic_slug", slug).eq("status", "approved").gte("updated_at", dayStart);
    const caseNeed = Math.max(0, quotas.catCases - (casesApprovedToday ?? 0));
    let casesApproved = 0;
    if (caseNeed > 0) {
      const { data: drafts } = await supabase.from("editorial_drafts")
        .select("id").eq("topic_slug", slug).eq("status", "draft")
        .order("fact_score", { ascending: false, nullsFirst: false })
        .order("generated_at", { ascending: false }).limit(caseNeed);
      const ids = (drafts ?? []).map((d: any) => d.id);
      if (ids.length) {
        const { data: upd } = await supabase.from("editorial_drafts")
          .update({ status: "approved", updated_at: nowIso }).in("id", ids).eq("status", "draft").select("id");
        casesApproved = (upd ?? []).length;
      }
    }
    byCategory[cat] = { articles: artApproved, cases: casesApproved };
  }
  result.byCategory = byCategory;

  // ---- 4. Backlog control: reject un-approved case drafts older than N days. ----
  // Editorial keeps generating; auto-approval only takes the day's best few, so
  // without this the draft pool would grow until the backlog guard stalls
  // generation. QA can still rescue anything from Rejected.
  const staleBefore = new Date(Date.now() - quotas.staleDays * 24 * 60 * 60 * 1000).toISOString();
  const { data: stale } = await supabase.from("editorial_drafts")
    .update({ status: "rejected", updated_at: nowIso })
    .eq("status", "draft").lt("generated_at", staleBefore).select("id");
  result.staleDraftsRejected = (stale ?? []).length;

  return json({ ok: true, ...result });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Server-side auth: service_role JWT (cron) or the dashboard's agent token.
  const denied = await requireAgent(request);
  if (denied) return denied;

  try {
    const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
    return await handle(supabase);
  } catch (error) {
    console.error(error);
    return json({ error: String(error) }, 500);
  }
});
