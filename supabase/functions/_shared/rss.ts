// Minimal RSS / Atom parser — Deno friendly, no deps.
// Extracts title, link, description, pubDate, guid per item.

export type RssItem = {
  title: string;
  url: string;
  description: string;
  publishedAt: string | null;
};

// Strip ALL CDATA markers, not just anchored ones — some feeds (e.g. ET) leak a
// trailing `]]>` into titles when the closing marker isn't at the string end.
const stripCdata = (s: string) => s.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim();
const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const decode = (s: string) =>
  s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&nbsp;", " ");

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
    items.push({ title, url: link, description, publishedAt });
  }
  return items;
}
