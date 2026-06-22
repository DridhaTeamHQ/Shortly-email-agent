// Quality gate for the Daily Wrap scrape. Drops low-signal "filler" stories
// (sports, celebrity, horoscopes, listicles, viral clips, live blogs) so the
// digest carries real news. Conservative by design: when unsure, keep the item.

const JUNK_TITLE_PATTERNS: RegExp[] = [
  // Sports
  /\b(cricket|ipl|t20|odi|ranji|test match|world cup|asia cup|wicket|batting|bowler|innings|run chase|playing xi|premier league|la liga|champions league|fifa|formula\s?1|f1 grand prix)\b/i,
  /\bwins? by \d+\s+(runs|wickets|goals)\b/i,
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
  // Live blogs / scores
  /\blive (updates|blog|score|coverage)\b/i,
  /\bhighlights?:/i,
  // Match reports: "Team A vs Team B", scorelines, sport verbs.
  /\svs\.?\s/i,
  /\b(beat|beats|thrash|thrashe?d|defeat|defeats|edge|edges|clinch|clinches|hammer|hammers|knock(ed)? out)\b.*\b\d+[-–]\d+\b/i,
  /\b\d+[-–]\d+\b.*\b(win|won|victory|draw|defeat)\b/i,
];

const JUNK_URL_PATTERNS: RegExp[] = [
  /\/(sport|sports|cricket|football|tennis)\//i,
  /\/(entertainment|movies|bollywood|hollywood|television|web-series|lifestyle|fashion|food|travel|astrology|horoscope|viral|trending|photos|gallery)\//i,
  /\/(quiz|quizzes|memes?)\//i,
];

// High-signal sections get a small rank bump so analysis floats above wire copy.
const SIGNAL_URL_PATTERNS: RegExp[] = [
  /\/(explained|analysis|opinion|editorial|business|economy|policy|world|international|science|technology)\//i,
];

export function looksLikeJunk(title: string, url: string): boolean {
  const t = title ?? "";
  const u = url ?? "";
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
