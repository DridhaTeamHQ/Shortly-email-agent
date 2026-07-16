// Minimal RSS / Atom parser — Deno friendly, no deps.
// Extracts title, link, description, pubDate, guid per item.

export type RssItem = {
  title: string;
  url: string;
  description: string;
  publishedAt: string | null;
  // Lead image from the item's media tags (or first inline <img>); null when
  // the feed carries none.
  image: string | null;
};

// Strip ALL CDATA markers, not just anchored ones — some feeds (e.g. ET) leak a
// trailing `]]>` into titles when the closing marker isn't at the string end.
const stripCdata = (s: string) => s.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim();
const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const decode = (s: string) =>
  s
    // Numeric entities first (e.g. &#8217; -> ’, &#x2019; -> ’), then named ones.
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return m; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return m; } })
    .replaceAll("&rsquo;", "’").replaceAll("&lsquo;", "‘")
    .replaceAll("&ldquo;", "“").replaceAll("&rdquo;", "”")
    .replaceAll("&mdash;", "—").replaceAll("&ndash;", "–").replaceAll("&hellip;", "…")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&nbsp;", " ");

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i;

function cleanImageUrl(raw: string | undefined | null): string | null {
  const url = decode(String(raw ?? "")).trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

// Lead image for an item, in priority order: media:content (image medium/type
// or image-extension URL), media:thumbnail, image-typed enclosure, then the
// first inline <img> in the description/content HTML. Feeds without any of
// these simply return null — the site degrades to a text card.
function extractImage(block: string): string | null {
  for (const m of block.matchAll(/<media:content\b[^>]*>/gi)) {
    const tag = m[0];
    const url = cleanImageUrl(tag.match(/url=["']([^"']+)["']/i)?.[1]);
    if (!url) continue;
    const medium = tag.match(/medium=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const type = tag.match(/type=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (medium === "image" || type?.startsWith("image/") || IMAGE_EXT.test(url)) return url;
  }
  const thumb = cleanImageUrl(block.match(/<media:thumbnail\b[^>]*url=["']([^"']+)["']/i)?.[1]);
  if (thumb) return thumb;
  for (const m of block.matchAll(/<enclosure\b[^>]*>/gi)) {
    const tag = m[0];
    const url = cleanImageUrl(tag.match(/url=["']([^"']+)["']/i)?.[1]);
    if (!url) continue;
    const type = tag.match(/type=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (type?.startsWith("image/") || IMAGE_EXT.test(url)) return url;
  }
  // Inline <img> in the raw description/content HTML (must run BEFORE any
  // tag-stripping, so read straight from the block). Feeds often entity-encode
  // the HTML, so also try a decoded copy.
  for (const html of [block, decode(block)]) {
    const img = cleanImageUrl(html.match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1]);
    if (img) return img;
  }
  return null;
}

function tagValue(block: string, tag: string): string {
  // Try element form. Strip CDATA both before AND after decoding, because some feeds
  // encode the closing bracket as `]]&gt;`, which only becomes `]]>` after decode.
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (m) return stripCdata(decode(stripTags(stripCdata(m[1])))).trim();
  // Self-closing href attr (Atom <link href="..." />)
  const m2 = block.match(new RegExp(`<${tag}[^>]*href=["']([^"']+)["']`, "i"));
  if (m2) return m2[1];
  return "";
}

export function parseFeed(xml: string): RssItem[] {
  const items: RssItem[] = [];
  // RSS <item> and Atom <entry>
  const blocks = [
    ...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)
  ].map((m) => m[0]);

  for (const block of blocks) {
    const title = tagValue(block, "title");
    const link = tagValue(block, "link") || tagValue(block, "guid");
    const description =
      tagValue(block, "description") ||
      tagValue(block, "summary") ||
      tagValue(block, "content");
    const publishedAt =
      tagValue(block, "pubDate") || tagValue(block, "published") || tagValue(block, "updated") || null;

    if (!title || !link) continue;
    items.push({ title, url: link, description, publishedAt, image: extractImage(block) });
  }
  return items;
}
