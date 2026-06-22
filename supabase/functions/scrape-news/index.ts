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

  let inserted = 0;
  if (unique.length > 0) {
    // upsert on url so re-scrapes are no-ops for existing articles
    const { data, error } = await supabase
      .from("articles")
      .upsert(unique, { onConflict: "url", ignoreDuplicates: true })
      .select("id");
    if (error) return json({ error: error.message, errors }, 500);
    inserted = data?.length ?? 0;
  }

  return json({ scraped: scraped.length, dropped, unique: unique.length, inserted, errors });
});
