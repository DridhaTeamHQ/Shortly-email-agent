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
          // Browser-like UA + Accept: several Indian outlets (Business Standard,
          // Moneycontrol, News18, Firstpost) 403 a bot UA on their RSS. This is a
          // plain public-feed fetch, just presented the way a feed reader would.
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept": "application/rss+xml, application/xml, text/xml, */*",
          },
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
  // Per-source diversity cap: a single prolific feed (e.g. the Explained feed
  // publishing 30 items) must NOT eat the whole run, or the pool — and every
  // downstream feed/topic — ends up dominated by one masthead. Take at most this
  // many of each source's top-ranked items first; only if that leaves the run
  // under SCRAPE_LIMIT do we backfill with the next-best regardless of source.
  const PER_SOURCE_CAP = (() => {
    const v = Number(Deno.env.get("SCRAPE_PER_SOURCE_CAP"));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 10;
  })();
  const sorted = fresh
    .slice()
    .sort((a, b) => (Number(b.rank_score) || 0) - (Number(a.rank_score) || 0));
  const perSource = new Map<string, number>();
  const ranked: Array<Record<string, unknown>> = [];
  const takenUrls = new Set<string>();
  for (const item of sorted) {
    if (ranked.length >= SCRAPE_LIMIT) break;
    const src = String(item.source ?? "unknown");
    const used = perSource.get(src) ?? 0;
    if (used >= PER_SOURCE_CAP) continue;
    perSource.set(src, used + 1);
    ranked.push(item);
    takenUrls.add(item.url as string);
  }
  // Backfill only when diversity caps left the run short (few feeds responded).
  if (ranked.length < SCRAPE_LIMIT) {
    for (const item of sorted) {
      if (ranked.length >= SCRAPE_LIMIT) break;
      if (takenUrls.has(item.url as string)) continue;
      ranked.push(item);
    }
  }

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
