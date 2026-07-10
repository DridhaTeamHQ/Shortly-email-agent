// list-articles: returns articles for the QA dashboard.
// GET ?status=summarized|approved|rejected|sent|all (default: summarized)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { matchesCategoryContent } from "../_shared/category-quality.ts";

function istDayWindow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const startMs = Date.UTC(value("year"), value("month") - 1, value("day")) - (5.5 * 60 * 60 * 1000);
  const endMs = startMs + (24 * 60 * 60 * 1000);
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "summarized";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "60", 10) || 60, 1000);

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const { start: istStart, end: istEnd } = istDayWindow();
  let query = supabase
    .from("articles")
    .select("id,title,url,summary,edited_title,edited_summary,source,topic,category,section,status,rank_score,fact_score,fact_label,fact_notes,scraped_at,summarized_at,reviewed_at,sent_at")
    .order("summarized_at", { ascending: false, nullsFirst: false })
    .order("reviewed_at", { ascending: false, nullsFirst: false })
    .order("scraped_at", { ascending: false, nullsFirst: false })
    .order("rank_score", { ascending: false })
    .limit(limit);

  if (status !== "all") query = query.eq("status", status);
  if (status === "summarized") query = query.gte("summarized_at", istStart).lt("summarized_at", istEnd);
  if (status === "approved" || status === "rejected") query = query.gte("reviewed_at", istStart).lt("reviewed_at", istEnd);

  const { data: rawArticles, error } = await query;
  if (error) return json({ error: error.message }, 500);
  const data = (rawArticles ?? []).filter((article: any) =>
    article.category !== "Real Estate" || matchesCategoryContent("Real Estate", article.edited_title || article.title, article.edited_summary || article.summary || "")
  );

  // BREAKING strip for the dashboard: prominence x cross-outlet velocity x
  // trust, freshness-decayed — computed by the breaking_news view (single
  // source of truth in SQL). Unreviewed first so QA fast-tracks them.
  const { data: breaking } = await supabase
    .from("breaking_news")
    .select("id,title,edited_title,source,category,status,prominence,source_count,fact_score,breaking_score,scraped_at")
    .order("breaking_score", { ascending: false })
    .limit(8);

  // Also include counts per status for the dashboard
  const [summarizedCount, approvedCount, rejectedCount, sentCount] = await Promise.all([
    supabase.from("articles").select("id", { count: "exact", head: true }).eq("status", "summarized").gte("summarized_at", istStart).lt("summarized_at", istEnd),
    supabase.from("articles").select("id", { count: "exact", head: true }).eq("status", "approved").gte("reviewed_at", istStart).lt("reviewed_at", istEnd),
    supabase.from("articles").select("id", { count: "exact", head: true }).eq("status", "rejected").gte("reviewed_at", istStart).lt("reviewed_at", istEnd),
    supabase.from("articles").select("id", { count: "exact", head: true }).eq("status", "sent"),
  ]);

  const tally: Record<string, number> = {
    summarized: summarizedCount.count ?? 0,
    approved: approvedCount.count ?? 0,
    rejected: rejectedCount.count ?? 0,
    sent: sentCount.count ?? 0,
  };

  return json({ articles: data ?? [], counts: tally, breaking: breaking ?? [] });
});
