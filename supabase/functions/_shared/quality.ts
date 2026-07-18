// Quality gate for the General scrape. Drops low-signal filler stories
// (celebrity, horoscopes, listicles, viral clips, live blogs) while allowing
// real sports/business/world/science news. Conservative by design: when unsure,
// keep the item.

const JUNK_TITLE_PATTERNS: RegExp[] = [
  // Entertainment / celebrity
  /\b(bollywood|tollywood|box office|movie review|film review|trailer|teaser|first look|web series|ott release|bigg boss|koffee with karan|red carpet|met gala)\b/i,
  /\b(actor|actress|singer|rapper)\b.*\b(dating|wedding|divorce|baby|spotted|slams|reacts|breaks silence)\b/i,
  // Soft / clickbait / lifestyle filler
  /\b(horoscope|zodiac|astrolog|tarot|numerolog|rashifal|panchang)\b/i,
  /\b(weight loss|skincare|recipe|home remed|beauty tips|grooming)\b/i,
  /\b(goes viral|viral video|caught on camera|watch:|must watch|in pics|in pictures|photo gallery|see pics|netizens|trolls?|meme)\b/i,
  // Listicle / explainer-bait
  /^\s*\d+\s+(things|ways|tips|reasons|facts|foods|habits|signs|rules|hacks)\b/i,
  /\b(top|best)\s+\d+\b/i,
  /\b(you (should|need to) know|here'?s (everything|all) you|things to know)\b/i,
  /\bquiz\b/i,
  /\b(hindi translation|in hindi|hindi version)\b/i,
  // Live blogs / scores
  /\blive (updates|blog|score|coverage)\b/i,
  /\bhighlights?:/i,
];

const JUNK_URL_PATTERNS: RegExp[] = [
  /\/(entertainment|movies|bollywood|hollywood|television|web-series|lifestyle|fashion|food|travel|astrology|horoscope|viral|trending|photos|gallery)\//i,
  /\/(quiz|quizzes|memes?)\//i,
];

// High-signal sections get a small rank bump so analysis floats above wire copy.
const SIGNAL_URL_PATTERNS: RegExp[] = [
  /\/(explained|analysis|opinion|editorial|business|economy|policy|world|international|science|technology|sport|sports|politics|political-pulse|elections)\//i,
];

// English-only feed: any Indic-script headline (Devanagari, Bengali, Tamil,
// Telugu, Kannada, Malayalam, Gujarati, Gurmukhi, Odia) is dropped at scrape
// time, along with "Hindi translation of…" editorial reposts.
const INDIC_SCRIPT = /[ऀ-ൿ]/; // Devanagari .. Malayalam blocks

export function looksLikeJunk(title: string, url: string): boolean {
  const t = title ?? "";
  const u = url ?? "";
  if (INDIC_SCRIPT.test(t)) return true;
  if (/\/\/(hindi|telugu|tamil|bangla|bengali|marathi|malayalam|kannada|gujarati|punjabi|urdu)\./i.test(u)) return true;
  if (JUNK_URL_PATTERNS.some((p) => p.test(u))) return true;
  if (JUNK_TITLE_PATTERNS.some((p) => p.test(t))) return true;
  // Drop near-empty or all-caps shouty headlines.
  if (t.trim().length < 25) return true;
  return false;
}

// Returns a multiplier applied to the source weight (0.85 - 1.15).
export function qualityScore(title: string, url: string): number {
  let score = 1;
  if (SIGNAL_URL_PATTERNS.some((p) => p.test(url ?? ""))) score += 0.15;
  // Penalise very short or question headlines slightly.
  if ((title ?? "").trim().endsWith("?")) score -= 0.05;
  if ((title ?? "").length < 40) score -= 0.05;
  return Math.max(0.85, Math.min(1.15, score));
}
