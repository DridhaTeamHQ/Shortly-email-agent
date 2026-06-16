// review-article: QA action endpoint.
// POST { id, action: "approve"|"reject"|"edit"|"reorder", edited_title?, edited_summary?, rank_score?, reviewer? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";

type Action = "approve" | "reject" | "edit" | "reorder";

function utcDayWindow() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: {
    id?: string;
    action?: Action;
    edited_title?: string;
    edited_summary?: string;
    reviewer?: string;
    section?: string;
    rank_score?: number;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const { id, action, edited_title, edited_summary, reviewer, section, rank_score } = body;
  if (!id) return json({ error: "id is required" }, 400);
  if (!action || !["approve", "reject", "edit", "reorder"].includes(action))
    return json({ error: "action must be approve|reject|edit|reorder" }, 400);

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  const patch: Record<string, unknown> = {
    reviewed_at: new Date().toISOString(),
    reviewed_by: reviewer ?? null
  };

  // Allow QA to set section (wrapped/ahead) on any action
  if (section && ["wrapped", "ahead"].includes(section)) {
    patch.section = section;
  }

  if (action === "edit") {
    if (!edited_title?.trim() && !edited_summary?.trim() && typeof rank_score !== "number") {
      return json({ error: "edited_title, edited_summary, or rank_score required for edit" }, 400);
    }
    if (edited_title?.trim()) patch.edited_title = edited_title.trim();
    if (edited_summary?.trim()) patch.edited_summary = edited_summary.trim();
    // Editing doesn't auto-approve; QA can edit then approve in two clicks
  } else if (action === "reorder") {
    if (typeof rank_score !== "number" || Number.isNaN(rank_score)) {
      return json({ error: "rank_score is required for reorder" }, 400);
    }
  } else if (action === "approve") {
    const { start, end } = utcDayWindow();
    const { count, error: countError } = await supabase
      .from("articles")
      .select("id", { count: "exact", head: true })
      .eq("status", "approved")
      .gte("reviewed_at", start)
      .lt("reviewed_at", end);

    if (countError) return json({ error: countError.message }, 500);
    if ((count ?? 0) >= 10) {
      return json({ error: "Daily approval limit reached. Remove one approved article before approving another." }, 409);
    }

    patch.status = "approved";
    if (edited_title?.trim()) patch.edited_title = edited_title.trim();
    if (edited_summary?.trim()) patch.edited_summary = edited_summary.trim();
  } else if (action === "reject") {
    patch.status = "rejected";
  }

  if (typeof rank_score === "number" && !Number.isNaN(rank_score)) {
    patch.rank_score = rank_score;
  }

  const { data, error } = await supabase
    .from("articles")
    .update(patch)
    .eq("id", id)
    .select("id,status,edited_title,edited_summary,reviewed_at,rank_score")
    .single();

  if (error) return json({ error: error.message }, 500);
  return json({ article: data });
});
