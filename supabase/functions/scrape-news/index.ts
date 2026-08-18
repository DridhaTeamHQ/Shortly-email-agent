// scrape-news: pull items from registered sources, dedupe by URL, insert as
// `pending` articles. Idempotent — `url` is unique.
//
// Sources come from the `sources` DB table (registry: name/url/kind/topic/
// weight/enabled + health columns), falling back to the static sources.ts list
// if the table is empty/unreadable. Two source kinds:
//   rss     — parse the feed (title/description/image from the XML)
//   section — a category/breaking LANDING PAGE with no feed: extract article
//             links from the HTML, then fetch each NEW article's NewsArticle
//             JSON-LD / og: metadata for title, description, image, timestamp.
// After every run each source's health is recorded (failure_count,
// last_success_at, last_error); 10 consecutive failures auto-disable it, so a
// dead feed drops out of rotation without a code deploy.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { cleanArticleText, extractArticleMeta } from "../_shared/article-text.ts";
import { SOURCES as STATIC_SOURCES } from "../_shared/sources.ts";
import { parseFeed } from "../_shared/rss.ts";
import { looksLikeJunk, qualityScore } from "../_shared/quality.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { DESK_TOPIC_LIST } from "../_shared/desks.ts";

type RegistrySource = {
  name: string;
  url: string;
  kind: "rss" | "section";
  topic: string | null;
  weight: number;
  failure_count?: number;
};

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DISABLE_AFTER_FAILURES = 10;
const SECTION_LINK_CAP = 25; // candidate links per section page
const SECTION_META_CAP = 10; // article-page metadata fetches per section source

async function fetchWithRetry(url: string, accept: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2500));
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        redirect: "follow",
        headers: { "User-Agent": BROWSER_UA, "Accept": accept },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const decodeBasic = (s: string) =>
  s
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return m; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return m; } })
    .replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&nbsp;", " ");

// Does this look like an ARTICLE url (vs a nav/tag/video/live page)? Generic
// heuristics that hold across Indian + international publishers: a numeric CMS
// id, an /articles/ path, or a long hyphenated slug.
const NON_ARTICLE_PATH =
  /\/(live|liveblog|videos?|video-show|photos?|photostory|photogallery|web-stories|gallery|topic|topics|tags?|author|about|contact|subscribe|newsletters?|podcasts?|events?)\//i;

function looksLikeArticleUrl(u: URL): boolean {
  const path = u.pathname;
  if (NON_ARTICLE_PATH.test(path)) return false;
  if (/\d{6,}/.test(path)) return true; // TOI/ET .cms ids, HT/NDTV numeric ids
  if (/\/articles?\//i.test(path)) return true; // BBC /news/articles/<id>
  const last = path.split("/").filter(Boolean).pop() ?? "";
  return (last.match(/-/g) ?? []).length >= 3; // long hyphenated slug
}

// Pull candidate article links out of a section/landing page. Same-host only,
// anchor text kept as a provisional title (longest wins per URL).
function extractSectionLinks(html: string, baseUrl: string): Array<{ url: string; title: string }> {
  const base = new URL(baseUrl);
  const baseHost = base.hostname.replace(/^www\./, "");
  const byUrl = new Map<string, string>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let resolved: URL;
    try {
      resolved = new URL(m[1], base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(resolved.protocol)) continue;
    if (resolved.hostname.replace(/^www\./, "") !== baseHost) continue;
    if (!looksLikeArticleUrl(resolved)) continue;
    resolved.hash = "";
    const url = resolved.toString();
    const title = decodeBasic(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    const prev = byUrl.get(url) ?? "";
    if (title.length > prev.length) byUrl.set(url, title);
  }
  return [...byUrl.entries()].map(([url, title]) => ({ url, title }));
}

// When the story was actually published, per the feed. Feeds hand back every
// date format imaginable and some hand back junk, so this is deliberately
// strict: anything unparseable, in the future, or absurdly old is discarded
// rather than stored. A NULL here is honest -- consumers fall back to
// scraped_at -- whereas a wrong date silently corrupts every freshness ranking
// that reads it.
function parseFeedDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = new Date(String(raw).trim()).getTime();
  if (!Number.isFinite(t) || t <= 0) return null;
  const now = Date.now();
  // Clock skew between publishers is normal; a day into the future is not.
  if (t > now + 24 * 60 * 60 * 1000) return null;
  // Older than a year means a parse that landed on the wrong century.
  if (t < now - 365 * 24 * 60 * 60 * 1000) return null;
  return new Date(t).toISOString();
}

// BREAKING SIGNAL: does this item carry a breaking marker at scrape time?
// Three equivalent markers, per the newsroom rule that a source "flagging it
// breaking" includes a Latest/Live section, a LIVE/BREAKING headline prefix, or
// a breaking URL path. Recorded per article so Class A selection can measure
// how MANY independent sources flagged the same story, rather than inferring it
// purely from corroboration breadth.
function breakingSignal(
  kind: "rss" | "section",
  title: string,
  url: string,
): { flagged: boolean; reason: string | null } {
  if (/^\s*(?:breaking|just in|urgent|big breaking)\b[:\s—-]/i.test(title)) {
    return { flagged: true, reason: "headline-prefix" };
  }
  if (/\/(breaking|breaking-news|live-updates)\//i.test(url)) {
    return { flagged: true, reason: "url-path" };
  }
  // Section sources are the Latest/Live/Breaking landing pages themselves.
  if (kind === "section") return { flagged: true, reason: "live-section" };
  return { flagged: false, reason: null };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Server-side auth: service_role JWT (cron) or the dashboard's agent token.
  const denied = await requireAgent(request);
  if (denied) return denied;


  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // ---- Source registry (DB first, static fallback) ----
  let sources: RegistrySource[] = [];
  let registry = false;
  const { data: dbSources } = await supabase
    .from("sources")
    .select("name,url,kind,topic,weight,failure_count")
    .eq("enabled", true);
  if (dbSources && dbSources.length > 0) {
    sources = dbSources as RegistrySource[];
    registry = true;
  } else {
    sources = STATIC_SOURCES.map((s) => ({ name: s.name, url: s.url, kind: "rss" as const, topic: s.topic ?? null, weight: s.weight }));
  }

  const scraped: Array<Record<string, unknown>> = [];
  const errors: Array<{ source: string; error: string }> = [];
  const health = new Map<string, { ok: boolean; error?: string }>();
  let dropped = 0;

  await Promise.all(
    sources.map(async (src) => {
      try {
        if (src.kind === "section") {
          const html = await fetchWithRetry(src.url, "text/html,application/xhtml+xml,*/*;q=0.8");
          const links = extractSectionLinks(html, src.url).slice(0, SECTION_LINK_CAP);
          for (const link of links) {
            if (link.title && looksLikeJunk(link.title, link.url)) {
              dropped += 1;
              continue;
            }
            const sectionSignal = breakingSignal("section", link.title, link.url);
            scraped.push({
              title: link.title.slice(0, 500), // provisional; replaced by page metadata below
              url: link.url,
              raw_content: "",
              source: src.name,
              topic: src.topic ?? null,
              image_url: null,
              published_at: null,
              rank_score: Number(src.weight) * qualityScore(link.title, link.url),
              status: "pending",
              breaking_flag: sectionSignal.flagged,
              breaking_flag_reason: sectionSignal.reason,
              _section: true,
            });
          }
        } else {
          const xml = await fetchWithRetry(src.url, "application/rss+xml, application/xml, text/xml, */*");
          const items = parseFeed(xml);
          for (const item of items) {
            if (looksLikeJunk(item.title, item.url)) {
              dropped += 1;
              continue;
            }
            const cleanedDescription = cleanArticleText(item.description ?? "");
            const feedSignal = breakingSignal("rss", item.title, item.url);
            scraped.push({
              title: item.title.slice(0, 500),
              url: item.url,
              raw_content: cleanedDescription.slice(0, 4000),
              source: src.name,
              topic: src.topic ?? null,
              image_url: item.image ?? null,
              published_at: parseFeedDate(item.publishedAt),
              rank_score: Number(src.weight) * qualityScore(item.title, item.url),
              status: "pending",
              breaking_flag: feedSignal.flagged,
              breaking_flag_reason: feedSignal.reason,
            });
          }
        }
        health.set(src.name, { ok: true });
      } catch (error) {
        errors.push({ source: `${src.name} ${src.url}`, error: String(error) });
        health.set(src.name, { ok: false, error: String(error).slice(0, 300) });
      }
    })
  );

  const seen = new Set<string>();
  const unique = scraped.filter((row) => {
    const u = row.url as string;
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });

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

  const SCRAPE_LIMIT = (() => {
    const v = Number(Deno.env.get("SCRAPE_LIMIT"));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 120;
  })();
  const PER_SOURCE_CAP = (() => {
    const v = Number(Deno.env.get("SCRAPE_PER_SOURCE_CAP"));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 10;
  })();
  const WORLD_CAP = (() => {
    const v = Number(Deno.env.get("SCRAPE_WORLD_CAP"));
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 25;
  })();
  const sorted = fresh
    .slice()
    .sort((a, b) => (Number(b.rank_score) || 0) - (Number(a.rank_score) || 0));
  const perSource = new Map<string, number>();
  let worldUsed = 0;
  const ranked: Array<Record<string, unknown>> = [];
  const takenUrls = new Set<string>();

  // ---- reserved intake for the guaranteed desks -----------------------------
  // rank_score is source.weight x qualityScore, and the tech feeds carry the
  // lowest weights in the registry (0.75-0.80, against 0.95-1.00 for the big
  // India desks) from only four sources against fourteen. On a 1,800-item day
  // the global top-120 cut is decided entirely by the India/Politics/Business
  // feeds, so tech is not merely under-represented -- it is absent. Measured
  // 2026-08-18: six tech/science sources all fetching cleanly, zero failures,
  // ONE article ingested in three days.
  //
  // So take the best few from those topics BEFORE the open contest rather than
  // asking them to win it. This is a floor, not a boost: they keep their real
  // rank_score everywhere downstream, and a topic with nothing to offer simply
  // contributes nothing here.
  const DESK_FLOOR = (() => {
    const v = Number(Deno.env.get("SCRAPE_DESK_FLOOR"));
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 8;
  })();
  for (const topic of DESK_TOPIC_LIST) {
    let taken = 0;
    for (const item of sorted) {
      if (taken >= DESK_FLOOR || ranked.length >= SCRAPE_LIMIT) break;
      if (String(item.topic ?? "") !== topic) continue;
      if (takenUrls.has(item.url as string)) continue;
      const src = String(item.source ?? "unknown");
      const used = perSource.get(src) ?? 0;
      if (used >= PER_SOURCE_CAP) continue;
      perSource.set(src, used + 1);
      ranked.push(item);
      takenUrls.add(item.url as string);
      taken++;
    }
  }

  for (const item of sorted) {
    if (takenUrls.has(item.url as string)) continue;
    if (ranked.length >= SCRAPE_LIMIT) break;
    const src = String(item.source ?? "unknown");
    const used = perSource.get(src) ?? 0;
    if (used >= PER_SOURCE_CAP) continue;
    const isWorld = String(item.topic ?? "") === "World";
    if (isWorld && worldUsed >= WORLD_CAP) continue;
    perSource.set(src, used + 1);
    if (isWorld) worldUsed++;
    ranked.push(item);
    takenUrls.add(item.url as string);
  }
  if (ranked.length < SCRAPE_LIMIT) {
    for (const item of sorted) {
      if (ranked.length >= SCRAPE_LIMIT) break;
      if (takenUrls.has(item.url as string)) continue;
      ranked.push(item);
    }
  }

  // ---- Section items: fetch article-page metadata (JSON-LD NewsArticle →
  // og:) for the NEW urls that actually made the cut. Anchor text is often a
  // truncated headline and section links carry no description/image at all.
  let sectionEnriched = 0;
  const perSourceMeta = new Map<string, number>();
  const sectionRows = ranked.filter((r) => r._section);
  await Promise.all(
    sectionRows.map(async (row) => {
      const src = String(row.source);
      const used = perSourceMeta.get(src) ?? 0;
      if (used >= SECTION_META_CAP) return;
      perSourceMeta.set(src, used + 1);
      try {
        const html = await fetchWithRetry(String(row.url), "text/html,application/xhtml+xml,*/*;q=0.8");
        const meta = extractArticleMeta(html);
        if (meta.title && meta.title.length >= 20) row.title = meta.title.slice(0, 500);
        if (meta.description) row.raw_content = cleanArticleText(meta.description).slice(0, 4000);
        if (meta.image) row.image_url = meta.image;
        // JSON-LD datePublished is the most reliable date on a news page --
        // it is what Google News reads.
        if (meta.publishedAt) row.published_at = parseFeedDate(meta.publishedAt);
        sectionEnriched++;
      } catch {
        // keep the anchor-text version; the summarizer's full-article fallback
        // and the og:image backfill pass can still fill the gaps
      }
    })
  );
  // Drop section rows whose title never became a usable headline.
  const insertable = ranked.filter((r) => !r._section || String(r.title ?? "").trim().length >= 25);
  for (const r of insertable) delete r._section;

  let inserted = 0;
  if (insertable.length > 0) {
    const { data, error } = await supabase
      .from("articles")
      .upsert(insertable, { onConflict: "url", ignoreDuplicates: true })
      .select("id");
    if (error) return json({ error: error.message, errors }, 500);
    inserted = data?.length ?? 0;
  }

  // ---- Record source health in the registry ----
  if (registry) {
    const nowIso = new Date().toISOString();
    await Promise.all(
      sources.map(async (src) => {
        const h = health.get(src.name);
        if (!h) return;
        if (h.ok) {
          await supabase.from("sources")
            .update({ failure_count: 0, last_success_at: nowIso, last_error: null })
            .eq("name", src.name);
        } else {
          const failures = (src.failure_count ?? 0) + 1;
          await supabase.from("sources")
            .update({ failure_count: failures, last_error: h.error ?? "unknown", enabled: failures < DISABLE_AFTER_FAILURES })
            .eq("name", src.name);
        }
      })
    );
  }

  const byTopic: Record<string, number> = {};
  let withImage = 0;
  for (const r of insertable) {
    const t = String(r.topic ?? "none");
    byTopic[t] = (byTopic[t] ?? 0) + 1;
    if (r.image_url) withImage++;
  }

  return json({
    registry,
    sources: sources.length,
    scraped: scraped.length,
    dropped,
    unique: unique.length,
    new: fresh.length,
    considered: ranked.length,
    sectionEnriched,
    inserted,
    withImage,
    byTopic,
    errors,
  });
});
