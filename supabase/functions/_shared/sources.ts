// News sources for the daily scrape. RSS only — fast, polite, structured.
// `topic` doubles as the newsletter CATEGORY so it flows into the dashboard
// filters and the digest. All category feeds below were validated live
// (scripts/validate-feeds.mjs); bot-blocked / discontinued feeds were dropped.
export type Source = {
  name: string;
  url: string;
  weight: number;
  topic?: string;
  region?: string;
};

export const SOURCES: Source[] = [
  // ── General India headlines (drive the core daily picks) ──
  { name: "TOI", url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", weight: 1.0, topic: "India", region: "India" },
  { name: "ET", url: "https://economictimes.indiatimes.com/rssfeedstopstories.cms", weight: 0.95, topic: "India Business", region: "India" },
  { name: "The Hindu", url: "https://www.thehindu.com/news/national/feeder/default.rss", weight: 1.0, topic: "India", region: "India" },

  // ── Tech & AI ──
  { name: "Inc42", url: "https://inc42.com/feed/", weight: 1.0, topic: "Tech & AI", region: "India" },
  { name: "Medianama", url: "https://www.medianama.com/feed/", weight: 0.9, topic: "Tech & AI", region: "India" },
  { name: "ET Tech", url: "https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms", weight: 0.95, topic: "Tech & AI", region: "India" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml", weight: 0.85, topic: "Tech & AI", region: "Global" },
  { name: "Wired", url: "https://www.wired.com/feed/rss", weight: 0.85, topic: "Tech & AI", region: "Global" },
  { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/", weight: 0.85, topic: "Tech & AI", region: "Global" },

  // ── Jobs & Careers ──
  { name: "ET HRWorld", url: "https://hr.economictimes.indiatimes.com/rss/topstories", weight: 1.0, topic: "Jobs & Careers", region: "India" },
  { name: "Bloomberg Work Shift", url: "https://feeds.bloomberg.com/work-shift/news.rss", weight: 0.8, topic: "Jobs & Careers", region: "Global" },
  { name: "Harvard Business Review", url: "http://feeds.hbr.org/harvardbusiness", weight: 0.85, topic: "Jobs & Careers", region: "Global" },

  // ── Health & Wellness ──
  { name: "ET HealthWorld", url: "https://health.economictimes.indiatimes.com/rss/topstories", weight: 1.0, topic: "Health & Wellness", region: "India" },
  { name: "WHO Newsroom", url: "https://www.who.int/rss-feeds/news-english.xml", weight: 0.9, topic: "Health & Wellness", region: "Global" },
  { name: "Medical Xpress", url: "https://medicalxpress.com/rss-feed/", weight: 0.8, topic: "Health & Wellness", region: "Global" },

  // ── Money & Finance ──
  { name: "Mint Markets", url: "https://www.livemint.com/rss/markets", weight: 1.0, topic: "Money & Finance", region: "India" },
  { name: "ET Markets", url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", weight: 0.95, topic: "Money & Finance", region: "India" },
  { name: "ET Wealth", url: "https://economictimes.indiatimes.com/wealth/rssfeeds/837555174.cms", weight: 0.9, topic: "Money & Finance", region: "India" },
  { name: "Mint Money", url: "https://www.livemint.com/rss/money", weight: 0.9, topic: "Money & Finance", region: "India" },

  // ── Climate & Sustainability ──
  { name: "Down To Earth", url: "https://www.downtoearth.org.in/feed", weight: 1.0, topic: "Climate & Sustainability", region: "India" },
  { name: "Mongabay India", url: "https://india.mongabay.com/feed/", weight: 0.9, topic: "Climate & Sustainability", region: "India" },
  { name: "Bloomberg Green", url: "https://feeds.bloomberg.com/green/news.rss", weight: 0.8, topic: "Climate & Sustainability", region: "Global" },
  { name: "Carbon Brief", url: "https://www.carbonbrief.org/feed/", weight: 0.85, topic: "Climate & Sustainability", region: "Global" },

  // ── Culture & Cinema ──
  { name: "The Hindu Entertainment", url: "https://www.thehindu.com/entertainment/feeder/default.rss", weight: 0.95, topic: "Culture & Cinema", region: "India" },
  { name: "Scroll Culture", url: "https://feeds.feedburner.com/ScrollinArticles", weight: 0.85, topic: "Culture & Cinema", region: "India" },
  { name: "The Hollywood Reporter", url: "https://www.hollywoodreporter.com/feed/", weight: 0.8, topic: "Culture & Cinema", region: "Global" },
  { name: "Variety", url: "https://variety.com/feed/", weight: 0.8, topic: "Culture & Cinema", region: "Global" },

  // ── Automobile & EV ──
  { name: "Autocar India", url: "https://www.autocarindia.com/rss/news", weight: 0.95, topic: "Automobile & EV", region: "India" },
  { name: "ET Auto", url: "https://auto.economictimes.indiatimes.com/rss/topstories", weight: 0.95, topic: "Automobile & EV", region: "India" },
  { name: "EVreporter", url: "https://evreporter.com/feed/", weight: 0.85, topic: "Automobile & EV", region: "India" }
];
