// ai-insights: transparency + control for the self-learning layer.
//   GET  -> { model, memory, patterns, accuracy, activity, config }
//   POST { action: "save_config", guidance, category_prefs } -> persists to app_config
//
// "memory"   = what the AI has stored (embeddings, labelled examples, editor rewrites)
// "patterns" = what it has learned about selection (approve rate by topic/category)
// "config"   = the human's steering inputs (editorial guidance + per-category prefs)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";

type Row = {
  id: string;
  title: string;
  edited_title: string | null;
  summary: string | null;
  edited_summary: string | null;
  topic: string | null;
  status: string;
  suggestion_score: number | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
};

const norm = (s: string | null) => (s ?? "").trim();
const changed = (a: string | null, b: string | null) => norm(a) !== "" && norm(a) !== norm(b);

async function getConfig(supabase: ReturnType<typeof createClient>, key: string) {
  const { data } = await supabase.from("app_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  // ---- POST: save steering config ----
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (body.action !== "save_config") return json({ error: "unknown action" }, 400);
    const rows: Array<{ key: string; value: string; updated_at: string }> = [];
    if (typeof body.guidance === "string") {
      rows.push({ key: "EDITORIAL_GUIDANCE", value: body.guidance.slice(0, 4000), updated_at: new Date().toISOString() });
    }
    if (body.category_prefs && typeof body.category_prefs === "object") {
      rows.push({ key: "CATEGORY_PREFS", value: JSON.stringify(body.category_prefs), updated_at: new Date().toISOString() });
    }
    if (rows.length === 0) return json({ error: "nothing to save" }, 400);
    const { error } = await supabase.from("app_config").upsert(rows, { onConflict: "key" });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, saved: rows.map((r) => r.key) });
  }

  // ---- GET: insights ----
  const model = (await getConfig(supabase, "OPENAI_MODEL")) || Deno.env.get("OPENAI_MODEL") || "gpt-4o";
  const guidance = (await getConfig(supabase, "EDITORIAL_GUIDANCE")) || "";
  let category_prefs: Record<string, string> = {};
  try { category_prefs = JSON.parse((await getConfig(supabase, "CATEGORY_PREFS")) || "{}"); } catch { /* ignore */ }

  // Counts (head-only, cheap)
  const embeddedQ = await supabase.from("articles").select("id", { count: "exact", head: true }).not("embedding", "is", null);
  const pendingQ = await supabase.from("articles").select("id", { count: "exact", head: true }).eq("status", "pending");
  const embedded = embeddedQ.count ?? 0;
  const pending = pendingQ.count ?? 0;

  // Reviewed corpus (labelled) — fetch lightweight columns to compute patterns/rewrites/activity
  const { data: reviewedData, error } = await supabase
    .from("articles")
    .select("id,title,edited_title,summary,edited_summary,topic,status,suggestion_score,reviewed_at,reviewed_by")
    .in("status", ["approved", "sent", "rejected"])
    .order("reviewed_at", { ascending: false })
    .limit(2000);
  if (error) return json({ error: error.message }, 500);
  const reviewed = (reviewedData ?? []) as Row[];

  const isApproved = (r: Row) => r.status === "approved" || r.status === "sent";
  const rewrites = reviewed.filter((r) => changed(r.edited_title, r.title) || changed(r.edited_summary, r.summary)).length;

  // Selection patterns by topic/category
  const byTopic = new Map<string, { approved: number; rejected: number }>();
  for (const r of reviewed) {
    const k = norm(r.topic) || "(uncategorised)";
    const e = byTopic.get(k) ?? { approved: 0, rejected: 0 };
    if (isApproved(r)) e.approved++; else if (r.status === "rejected") e.rejected++;
    byTopic.set(k, e);
  }
  const patterns = [...byTopic.entries()]
    .map(([key, v]) => ({ key, approved: v.approved, rejected: v.rejected, rate: Math.round((v.approved / Math.max(1, v.approved + v.rejected)) * 100) }))
    .sort((a, b) => (b.approved + b.rejected) - (a.approved + a.rejected));

  // Score accuracy: among reviewed rows that had a suggestion_score, did high predict approve / low predict reject?
  const scored = reviewed.filter((r) => r.suggestion_score != null);
  let accuracy: { scored: number; highApprovedPct: number; lowRejectedPct: number } | null = null;
  if (scored.length > 0) {
    const high = scored.filter((r) => (r.suggestion_score ?? 0) >= 66);
    const low = scored.filter((r) => (r.suggestion_score ?? 0) < 33);
    accuracy = {
      scored: scored.length,
      highApprovedPct: high.length ? Math.round((high.filter(isApproved).length / high.length) * 100) : 0,
      lowRejectedPct: low.length ? Math.round((low.filter((r) => r.status === "rejected").length / low.length) * 100) : 0
    };
  }

  // Recent activity (what's being done)
  const activity = reviewed
    .filter((r) => r.reviewed_at)
    .slice(0, 25)
    .map((r) => ({
      when: r.reviewed_at,
      who: r.reviewed_by || "system",
      action: r.status === "rejected" ? "rejected" : (r.status === "sent" ? "sent" : "approved"),
      title: norm(r.edited_title) || r.title
    }));

  return json({
    model,
    memory: { embedded, reviewed: reviewed.length, rewrites, rewriteGoal: 100, pending },
    patterns,
    accuracy,
    activity,
    config: { guidance, category_prefs }
  });
});
