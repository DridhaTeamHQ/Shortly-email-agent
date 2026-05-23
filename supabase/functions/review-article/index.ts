// review-article: QA action endpoint.
// POST { id, action: "approve"|"reject"|"edit", edited_summary?, reviewer? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";

type Action = "approve" | "reject" | "edit";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { id?: string; action?: Action; edited_summary?: string; reviewer?: string; section?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const { id, action, edited_summary, reviewer, section } = body;
  if (!id) return json({ error: "id is required" }, 400);
  if (!action || !["approve", "reject", "edit"].includes(action))
    return json({ error: "action must be approve|reject|edit" }, 400);

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
    if (!edited_summary?.trim()) return json({ error: "edited_summary required for edit" }, 400);
    patch.edited_summary = edited_summary.trim();
    // Editing doesn't auto-approve; QA can edit then approve in two clicks
  } else if (action === "approve") {
    patch.status = "approved";
    if (edited_summary?.trim()) patch.edited_summary = edited_summary.trim();
  } else if (action === "reject") {
    patch.status = "rejected";
  }

  const { data, error } = await supabase
    .from("articles")
    .update(patch)
    .eq("id", id)
    .select("id,status,edited_summary,reviewed_at")
    .single();

  if (error) return json({ error: error.message }, 500);
  return json({ article: data });
});
