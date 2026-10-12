/* Plain-text alternative, derived from the HTML so the wording never drifts.
 *
 * HTML-only mail is a standing spam-filter penalty: a real mail client always
 * sends a text/plain part alongside text/html. Links keep their target in
 * brackets so the text version is still usable on its own. */
const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#039;": "'", "&#39;": "'",
  "&nbsp;": " ", "&rarr;": "->", "&mdash;": "-", "&ndash;": "-", "&hellip;": "...",
};

export function htmlToText(html: string) {
  return html
    .replace(/<(head|style|script|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      return text && !href.startsWith("mailto:") ? `${text} [${href}]` : text;
    })
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<(p|h[1-6]|div|li)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|h[1-6]|tr|div|li|table)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&[#a-z0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
