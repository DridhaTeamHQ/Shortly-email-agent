// list-articles: returns articles for the QA dashboard.
// GET ?status=summarized|approved|rejected|sent|all (default: summarized)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "summarized";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "60", 10) || 60, 200);

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  let query = supabase
    .from("articles")
    .select("id,title,url,summary,edited_summary,source,topic,status,rank_score,scraped_at,summarized_at,reviewed_at,sent_at")
    .order("rank_score", { ascending: false })
    .order("scraped_at", { ascending: false })
    .limit(limit);

  if (status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return json({ error: error.message }, 500);

  // Also include counts per status for the dashboard
  const { data: counts } = await supabase
    .from("articles")
    .select("status", { count: "exact", head: false });

  const tally: Record<string, number> = {};
  (counts ?? []).forEach((r) => {
    tally[r.status] = (tally[r.status] ?? 0) + 1;
  });

  return json({ articles: data ?? [], counts: tally });
});
