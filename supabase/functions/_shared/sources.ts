// News sources for the daily Wrap scrape. Section-specific RSS (not generic
// "top stories") so the feed carries real national/business/world news instead
// of cricket, celebrity and horoscope filler. Per-source errors are tolerated,
// so a temporarily dead feed never blocks the scrape.
export type Source = {
  name: string;
  url: string;
  weight: number;
  topic?: string;
};

export const SOURCES: Source[] = [
  // National / India
  { name: "The Hindu", url: "https://www.thehindu.com/news/national/feeder/default.rss", weight: 1.0, topic: "India" },
  { name: "Indian Express", url: "https://indianexpress.com/section/india/feed/", weight: 0.95, topic: "India" },
  { name: "NDTV India", url: "https://feeds.feedburner.com/ndtvnews-india-news", weight: 0.85, topic: "India" },

  // Explained / analysis (high signal — surfaces the "why")
  { name: "Indian Express Explained", url: "https://indianexpress.com/section/explained/feed/", weight: 1.0, topic: "Explained" },

  // Business / economy
  { name: "The Hindu Business", url: "https://www.thehindu.com/business/feeder/default.rss", weight: 0.95, topic: "Business" },
  { name: "Mint", url: "https://www.livemint.com/rss/news", weight: 0.95, topic: "Business" },

  // World
  { name: "The Hindu World", url: "https://www.thehindu.com/news/international/feeder/default.rss", weight: 0.9, topic: "World" },
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", weight: 0.9, topic: "World" },

  // Science / technology
  { name: "The Hindu Sci-Tech", url: "https://www.thehindu.com/sci-tech/feeder/default.rss", weight: 0.8, topic: "Science" },
];
