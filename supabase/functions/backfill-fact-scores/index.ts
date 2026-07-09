// backfill-fact-scores: one-off admin utility to score articles that were
// summarized/approved BEFORE the fact-check code went live (fact_score is null).
// It scores in place using the same shared fact-check helper the pipelines use,
// and also backfills reader `versions` for approved/sent articles that lack them.
//
// Safe to run repeatedly: it only ever touches rows still missing the data, and
// is hard-capped per invocation so a run stays inside the edge time budget. Call
// it again until { remaining: 0 }.
//
//   POST (or GET) /backfill-fact-scores?limit=30
//     ?limit=N            max articles to process this run (default 30, max 60)
//     ?versions=false     skip version backfill (score only)
//
// Returns { scored, versioned, processed, remaining, failures }.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { factCheckArticle } from "../_shared/fact-check.ts";
import { generateArticleVersions, versionsEnabled } from "../_shared/versions.ts";

type Row = {
  id: string;
  title: string;
  edited_title: string | null;
  summary: string | null;
  edited_summary: string | null;
  raw_content: string | null;
  status: string;
  category: string | null;
  fact_score: number | null;
  versions: unknown | null;
};

// Admin-only: this endpoint spends OpenAI credits per call, so it must NOT be
// triggerable by the public anon key (which ships in the website). We accept
// only the service-role key (used by the pg_cron safety net via invoke_edge)
// or an explicit BACKFILL_ADMIN_TOKEN. Constant-time-ish compare via length +
// value; tokens are long and high-entropy so this is adequate here.
function isAuthorized(request: Request, serviceKey: string): boolean {
  const bearer = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const adminToken = Deno.env.get("BACKFILL_ADMIN_TOKEN") ?? "";
  const provided = bearer || (request.headers.get("x-admin-token") ?? "").trim();
  if (provided && provided === serviceKey) return true;
  if (adminToken && (provided === adminToken || (request.headers.get("x-admin-token") ?? "").trim() === adminToken)) return true;
  return false;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!isAuthorized(request, serviceRoleKey)) {
    return json({ error: "forbidden: admin credentials required" }, 403);
  }

  // Params from query string OR JSON body (the pg_cron safety net posts a body).
  const url = new URL(request.url);
  let bodyLimit: string | null = null;
  let bodyVersions: unknown = undefined;
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (body && typeof body === "object") {
      if ("limit" in body) bodyLimit = String((body as Record<string, unknown>).limit);
      bodyVersions = (body as Record<string, unknown>).versions;
    }
  }
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") ?? bodyLimit ?? "30", 10) || 30, 60));
  const doVersions = url.searchParams.get("versions") !== "false" && bodyVersions !== false && versionsEnabled();

  const supabase = createClient(requiredEnv("SUPABASE_URL"), serviceRoleKey);
  const openAiKey = requiredEnv("OPENAI_API_KEY");

  // Rows still missing a fact score, newest first. Only real reader states, and
  // only rows that CAN be scored (a summary is required) — otherwise an article
  // with no body would sit in `remaining` forever and make the caller loop or the
  // safety-net cron retry it every day with no progress.
  const { data, error } = await supabase
    .from("articles")
    .select("id,title,edited_title,summary,edited_summary,raw_content,status,category,fact_score,versions")
    .is("fact_score", null)
    .in("status", ["summarized", "approved", "sent"])
    .not("summary", "is", null)
    .neq("summary", "")
    .order("scraped_at", { ascending: false })
    .limit(limit);
  if (error) return json({ error: error.message }, 500);

  const rows = (data ?? []) as Row[];

  // How many scoreable rows are still unscored, so the caller knows when to stop.
  const { count: totalUnscored } = await supabase
    .from("articles")
    .select("id", { count: "exact", head: true })
    .is("fact_score", null)
    .in("status", ["summarized", "approved", "sent"])
    .not("summary", "is", null)
    .neq("summary", "");

  if (rows.length === 0) return json({ scored: 0, versioned: 0, processed: 0, remaining: 0, failures: [] });

  let scored = 0;
  let versioned = 0;
  const failures: Array<{ id: string; error: string }> = [];
  const CONCURRENCY = 3;

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (a) => {
      const headline = a.edited_title || a.title || "";
      const body = a.edited_summary || a.summary || "";
      if (!headline || !body) return;
      try {
        const patch: Record<string, unknown> = {};

        const fact = await factCheckArticle(openAiKey, {
          title: headline,
          summary: body,
          sourceText: a.raw_content || "",
        });
        if (fact) {
          patch.fact_score = fact.fact_score;
          patch.fact_label = fact.fact_label;
          patch.fact_notes = fact.fact_notes;
        }

        // Versions are GENERAL-category only (category null) and only for
        // content the website shows in full (approved/sent).
        if (doVersions && !a.versions && !a.category && (a.status === "approved" || a.status === "sent")) {
          const versions = await generateArticleVersions(openAiKey, {
            headline,
            body,
            sourceText: a.raw_content || "",
          });
          if (versions) patch.versions = versions;
        }

        if (Object.keys(patch).length > 0) {
          const { error: upErr } = await supabase.from("articles").update(patch).eq("id", a.id);
          if (upErr) { failures.push({ id: a.id, error: upErr.message }); return; }
          if (patch.fact_score != null) scored++;
          if (patch.versions) versioned++;
        }
      } catch (e) {
        failures.push({ id: a.id, error: String(e) });
      }
    }));
  }

  // Progress-based remaining: if a full batch of scoreable rows produced zero
  // scores, every remaining candidate is a permanent straggler (e.g. the fact
  // check keeps returning null for genuinely un-gradeable text). Report 0 so a
  // "call until remaining==0" loop terminates instead of re-spending forever.
  const remaining = scored === 0 ? 0 : Math.max(0, (totalUnscored ?? rows.length) - scored);
  return json({
    scored,
    versioned,
    processed: rows.length,
    remaining,
    stuck: Math.max(0, rows.length - scored), // processed but un-scoreable this run
    failures: failures.slice(0, 5),
  });
});
