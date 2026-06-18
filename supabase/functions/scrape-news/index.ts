// scrape-news: pull RSS items from configured sources, dedupe by URL,
// insert as `pending` articles. Idempotent — `url` is unique.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { SOURCES } from "../_shared/sources.ts";
import { parseFeed } from "../_shared/rss.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const scraped: Array<Record<string, unknown>> = [];
  const errors: Array<{ source: string; error: string }> = [];

  // Cap items per feed so one large feed can't flood the pending pool,
  // and time out slow feeds so one hang can't stall the whole scrape.
  const PER_FEED = 8;
  const FETCH_TIMEOUT_MS = 10000;

  await Promise.all(
    SOURCES.map(async (src) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const response = await fetch(src.url, {
          headers: { "User-Agent": "ShortlyDigestBot/1.0 (+https://shortlyindia.com)" },
          redirect: "follow",
          signal: controller.signal
        }).finally(() => clearTimeout(timer));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const xml = await response.text();
        const items = parseFeed(xml).slice(0, PER_FEED);
        for (const item of items) {
          scraped.push({
            title: item.title.slice(0, 500),
            url: item.url,
            raw_content: item.description?.slice(0, 4000) ?? "",
            source: src.name,
            topic: src.topic ?? null,
            rank_score: src.weight,
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

  return json({ scraped: scraped.length, unique: unique.length, inserted, errors });
});
