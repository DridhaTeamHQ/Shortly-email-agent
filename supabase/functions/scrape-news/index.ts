// scrape-news: pull RSS items from configured sources, dedupe by URL,
// insert as `pending` articles. Idempotent — `url` is unique.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { cleanArticleText } from "../_shared/article-text.ts";
import { SOURCES } from "../_shared/sources.ts";
import { parseFeed } from "../_shared/rss.ts";
import { looksLikeJunk, qualityScore } from "../_shared/quality.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const scraped: Array<Record<string, unknown>> = [];
  const errors: Array<{ source: string; error: string }> = [];
  let dropped = 0;

  await Promise.all(
    SOURCES.map(async (src) => {
      try {
        const response = await fetch(src.url, {
          signal: AbortSignal.timeout(15_000),
          headers: { "User-Agent": "ShortlyDigestBot/1.0 (+https://shortly.example)" }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const xml = await response.text();
        const items = parseFeed(xml);
        for (const item of items) {
          // Quality gate: skip sports/celebrity/horoscope/listicle/viral filler.
          if (looksLikeJunk(item.title, item.url)) {
            dropped += 1;
            continue;
          }
          const cleanedDescription = cleanArticleText(item.description ?? "");
          scraped.push({
            title: item.title.slice(0, 500),
            url: item.url,
            raw_content: cleanedDescription.slice(0, 4000),
            source: src.name,
            topic: src.topic ?? null,
            rank_score: src.weight * qualityScore(item.title, item.url),
            status: "pending"
          });
        }
      } catch (error) {
        errors.push({ source: `${src.name} ${src.url}`, error: String(error) });
      }
    })
  );

  // Dedupe within batch by url
  const seen = new Set<string>();
  const unique = scraped.filter((row) => {
    const u = row.url as string;
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  // Drop URLs we already have so the cap is spent on genuinely NEW stories.
  // (Otherwise the top-ranked slots are always the same high-weight sources we
  // already scraped, and nothing fresh ever gets inserted.)
  // NOTE: build the existing-URL set by PAGINATING — PostgREST caps any single
  // select at 1000 rows, and a chunked `.in(url, [...])` over hundreds of long
  // URLs overflows the query string. Either silently misses existing URLs, so
  // duplicates leak into the "new" set and waste the cap. RSS only carries recent
  // items, so a 14-day window catches every realistic duplicate.
  const recentSince = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const existing = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; from < 50000; from += PAGE) {
    const { data: ex } = await supabase
      .from("articles")
      .select("url")
      .gte("scraped_at", recentSince)
      .order("scraped_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (!ex || ex.length === 0) break;
    for (const r of ex) existing.add(r.url as string);
    if (ex.length < PAGE) break;
  }
  const fresh = unique.filter((r) => !existing.has(r.url as string));

  // Cap each run to the highest-ranked NEW items. Kept deliberately generous so
  // that when a big story is covered by several outlets, ALL of that coverage
  // lands in the pool — trending clustering needs same-story DEPTH (3+ members
  // from 2+ sources), not just breadth. The downstream summarizer drains this in
  // batches of 40/invocation (auto cron runs 3 passes), so ~120 fits the budget.
  // Env-overridable so volume can be tuned without a redeploy.
  const SCRAPE_LIMIT = (() => {
    const v = Number(Deno.env.get("SCRAPE_LIMIT"));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 120;
  })();
  const ranked = fresh
    .slice()
    .sort((a, b) => (Number(b.rank_score) || 0) - (Number(a.rank_score) || 0))
    .slice(0, SCRAPE_LIMIT);

  let inserted = 0;
  if (ranked.length > 0) {
    // upsert on url so a race with another run is still a no-op for existing articles
    const { data, error } = await supabase
      .from("articles")
      .upsert(ranked, { onConflict: "url", ignoreDuplicates: true })
      .select("id");
    if (error) return json({ error: error.message, errors }, 500);
    inserted = data?.length ?? 0;
  }

  return json({ scraped: scraped.length, dropped, unique: unique.length, new: fresh.length, considered: ranked.length, inserted, errors });
});
