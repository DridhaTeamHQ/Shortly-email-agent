// Approves the morning's strongest General stories after both summary passes.
// This is intentionally narrow: category articles and case studies remain in
// their normal editorial workflows.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { requireAgent } from "../_shared/agent-auth.ts";

const GENERAL_LIMIT = 5;
const REVIEWER = "ai-morning-general";

function istDayWindow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const startMs = Date.UTC(value("year"), value("month") - 1, value("day")) - (5.5 * 60 * 60 * 1000);
  return { start: new Date(startMs).toISOString(), end: new Date(startMs + 24 * 60 * 60 * 1000).toISOString() };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const denied = await requireAgent(request);
  if (denied) return denied;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await request.json().catch(() => ({}));
  if (body?.scheduled !== true) return json({ error: "Scheduled morning approval only." }, 403);

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const { start, end } = istDayWindow();
  const { data: candidates, error } = await supabase
    .from("articles")
    .select("id")
    .eq("status", "summarized")
    .is("category", null)
    .gte("summarized_at", start)
    .lt("summarized_at", end)
    .order("rank_score", { ascending: false, nullsFirst: false })
    .order("scraped_at", { ascending: false })
    .limit(GENERAL_LIMIT);
  if (error) return json({ error: error.message }, 500);

  const ids = (candidates ?? []).map((article: { id: string }) => article.id);
  if (ids.length === 0) return json({ approved: 0, requested: GENERAL_LIMIT });

  const now = new Date().toISOString();
  const { data: approved, error: updateError } = await supabase
    .from("articles")
    .update({ status: "approved", reviewed_at: now, reviewed_by: REVIEWER })
    .in("id", ids)
    .eq("status", "summarized")
    .select("id");
  if (updateError) return json({ error: updateError.message }, 500);

  return json({ approved: (approved ?? []).length, requested: GENERAL_LIMIT });
});
