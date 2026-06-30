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
  const urls = unique.map((r) => r.url as string);
  const existing = new Set<string>();
  for (let i = 0; i < urls.length; i += 200) {
    const { data: ex } = await supabase
      .from("articles")
      .select("url")
      .in("url", urls.slice(i, i + 200));
    (ex ?? []).forEach((r) => existing.add(r.url as string));
  }
  const fresh = unique.filter((r) => !existing.has(r.url as string));

  // Cap each run to the 30 highest-ranked NEW items so we never flood the pipeline
  // (the downstream summarizer is rate-limited and must finish in the edge budget).
  const SCRAPE_LIMIT = 30;
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
