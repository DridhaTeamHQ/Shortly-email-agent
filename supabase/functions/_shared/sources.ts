// News sources for the General scrape. Section-specific RSS where possible so
// the feed carries real national/business/world/sports/science stories instead
// of celebrity, horoscope and viral filler. Per-source errors are tolerated, so
// a temporarily dead feed never blocks the scrape.
export type Source = {
  name: string;
  url: string;
  weight: number;
  topic?: string;
};

// Deliberately BROAD and multi-publisher: trending clustering only works when
// the SAME story is carried by several outlets, so every beat (national, world,
// business, tech) is covered by 3-4 independent mastheads. Per-source volume is
// capped at scrape time (SCRAPE_PER_SOURCE_CAP) so no single prolific feed — e.g.
// the Indian Express Explained analysis feed — can monopolise a run.
export const SOURCES: Source[] = [
  // ---- National / India (multiple mastheads on the same beat) ----
  { name: "The Hindu", url: "https://www.thehindu.com/news/national/feeder/default.rss", weight: 1.0, topic: "India" },
  { name: "Indian Express", url: "https://indianexpress.com/section/india/feed/", weight: 0.95, topic: "India" },
  { name: "Times of India", url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", weight: 0.9, topic: "India" },
  { name: "NDTV India", url: "https://feeds.feedburner.com/ndtvnews-india-news", weight: 0.9, topic: "India" },
  { name: "NDTV Top Stories", url: "https://feeds.feedburner.com/ndtvnews-top-stories", weight: 0.9, topic: "India" },
  { name: "Hindustan Times India", url: "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml", weight: 0.9, topic: "India" },
  { name: "Scroll.in", url: "https://scroll.in/feed", weight: 0.8, topic: "India" },
  { name: "Firstpost India", url: "https://www.firstpost.com/rss/india.xml", weight: 0.75, topic: "India" },
  { name: "News18 India", url: "https://www.news18.com/rss/india.xml", weight: 0.75, topic: "India" },

  // ---- Explained / analysis (high signal, but weighted DOWN + volume-capped
  // so it complements the news feeds instead of drowning them) ----
  { name: "Indian Express Explained", url: "https://indianexpress.com/section/explained/feed/", weight: 0.85, topic: "Explained" },

  // ---- Business / economy ----
  { name: "The Hindu Business", url: "https://www.thehindu.com/business/feeder/default.rss", weight: 0.95, topic: "Business" },
  { name: "Mint", url: "https://www.livemint.com/rss/news", weight: 0.95, topic: "Business" },
  { name: "LiveMint Companies", url: "https://www.livemint.com/rss/companies", weight: 0.85, topic: "Business" },
  { name: "LiveMint Markets", url: "https://www.livemint.com/rss/markets", weight: 0.85, topic: "Business" },
  { name: "Economic Times", url: "https://economictimes.indiatimes.com/rssfeedstopstories.cms", weight: 0.9, topic: "Business" },
  { name: "Economic Times Markets", url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", weight: 0.85, topic: "Business" },
  { name: "Moneycontrol", url: "https://www.moneycontrol.com/rss/latestnews.xml", weight: 0.85, topic: "Business" },
  { name: "Business Standard", url: "https://www.business-standard.com/rss/latest.rss", weight: 0.85, topic: "Business" },
  { name: "Indian Express Business", url: "https://indianexpress.com/section/business/feed/", weight: 0.85, topic: "Business" },
  { name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml", weight: 0.85, topic: "Business" },

  // ---- World ----
  { name: "The Hindu World", url: "https://www.thehindu.com/news/international/feeder/default.rss", weight: 0.9, topic: "World" },
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", weight: 0.9, topic: "World" },
  { name: "Indian Express World", url: "https://indianexpress.com/section/world/feed/", weight: 0.9, topic: "World" },
  { name: "Hindustan Times World", url: "https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml", weight: 0.85, topic: "World" },
  { name: "NDTV World", url: "https://feeds.feedburner.com/ndtvnews-world-news", weight: 0.85, topic: "World" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", weight: 0.8, topic: "World" },
  { name: "The Guardian World", url: "https://www.theguardian.com/world/rss", weight: 0.8, topic: "World" },

  // ---- Sports ----
  { name: "The Hindu Sport", url: "https://www.thehindu.com/sport/feeder/default.rss", weight: 0.8, topic: "Sports" },
  { name: "Times of India Sports", url: "https://timesofindia.indiatimes.com/rssfeeds/4719148.cms", weight: 0.75, topic: "Sports" },

  // ---- Science / technology ----
  { name: "The Hindu Sci-Tech", url: "https://www.thehindu.com/sci-tech/feeder/default.rss", weight: 0.8, topic: "Science" },
  { name: "Times of India Tech", url: "https://timesofindia.indiatimes.com/rssfeeds/66949542.cms", weight: 0.75, topic: "Technology" },
  { name: "Economic Times Tech", url: "https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms", weight: 0.8, topic: "Technology" },
  { name: "Indian Express Technology", url: "https://indianexpress.com/section/technology/feed/", weight: 0.8, topic: "Technology" },
  { name: "BBC Technology", url: "https://feeds.bbci.co.uk/news/technology/rss.xml", weight: 0.8, topic: "Technology" },
];
