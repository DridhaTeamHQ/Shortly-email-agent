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
  fact_score: number | null;
  versions: unknown | null;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "30", 10) || 30, 60);
  const doVersions = url.searchParams.get("versions") !== "false" && versionsEnabled();

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const openAiKey = requiredEnv("OPENAI_API_KEY");

  // Rows still missing a fact score, newest first. Only real reader states.
  const { data, error } = await supabase
    .from("articles")
    .select("id,title,edited_title,summary,edited_summary,raw_content,status,fact_score,versions")
    .is("fact_score", null)
    .in("status", ["summarized", "approved", "sent"])
    .order("scraped_at", { ascending: false })
    .limit(limit);
  if (error) return json({ error: error.message }, 500);

  const rows = (data ?? []) as Row[];

  // How many are still unscored overall, so the caller knows when to stop.
  const { count: totalUnscored } = await supabase
    .from("articles")
    .select("id", { count: "exact", head: true })
    .is("fact_score", null)
    .in("status", ["summarized", "approved", "sent"]);

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

        // Versions only matter for content the website shows in full.
        if (doVersions && !a.versions && (a.status === "approved" || a.status === "sent")) {
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

  const remaining = Math.max(0, (totalUnscored ?? rows.length) - scored);
  return json({
    scored,
    versioned,
    processed: rows.length,
    remaining,
    failures: failures.slice(0, 5),
  });
});
