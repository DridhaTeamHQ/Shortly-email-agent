// review-article: QA action endpoint.
// POST { id, action: "approve"|"reject"|"edit"|"reorder", edited_title?, edited_summary?, rank_score?, reviewer? }
// On approve, reader-facing alternate versions (ELI5 / TL;DR / deep dive /
// key numbers) are generated in the background and stored in articles.versions
// for the website. The approve response never waits on or fails from this.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { generateArticleVersions, versionsEnabled } from "../_shared/versions.ts";

async function generateAndStoreVersions(supabase: ReturnType<typeof createClient>, id: string): Promise<void> {
  try {
    const { data: a } = await supabase
      .from("articles")
      .select("id,title,edited_title,summary,edited_summary,raw_content,versions,category")
      .eq("id", id)
      .single();
    if (!a || a.versions) return; // already generated on a prior approve
    // Alternate reader versions (ELI5 / TL;DR / deep dive / key numbers) are
    // GENERAL-category only. Category short articles (Real Estate, Automobile,
    // Health & Wellness, Tech & AI, Markets & Startups) keep just the fact score.
    if (a.category) return;
    const versions = await generateArticleVersions(requiredEnv("OPENAI_API_KEY"), {
      headline: (a.edited_title || a.title || "") as string,
      body: (a.edited_summary || a.summary || "") as string,
      sourceText: (a.raw_content || "") as string,
    });
    if (versions) await supabase.from("articles").update({ versions }).eq("id", id);
  } catch {
    // Non-fatal by design: the article is approved either way.
  }
}

type Action = "approve" | "reject" | "edit" | "reorder";

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
    category?: string | null;
    rank_score?: number;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const { id, action, edited_title, edited_summary, reviewer, section, category, rank_score } = body;
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

  if (typeof category === "string") {
    const cleanCategory = category.trim();
    patch.category = cleanCategory || null;
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
    .select("id,status,edited_title,edited_summary,category,reviewed_at,rank_score")
    .single();

  if (error) return json({ error: error.message }, 500);

  if (action === "approve" && versionsEnabled()) {
    const task = generateAndStoreVersions(supabase, id);
    // Finish after the response when the runtime allows it; otherwise wait so
    // the work isn't killed with the isolate. Either way, failures are silent.
    const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (runtime?.waitUntil) runtime.waitUntil(task);
    else await task;
  }

  return json({ article: data });
});
