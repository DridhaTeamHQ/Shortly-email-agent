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

export const SOURCES: Source[] = [
  // National / India
  { name: "The Hindu", url: "https://www.thehindu.com/news/national/feeder/default.rss", weight: 1.0, topic: "India" },
  { name: "Indian Express", url: "https://indianexpress.com/section/india/feed/", weight: 0.95, topic: "India" },
  { name: "Times of India", url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", weight: 0.9, topic: "India" },
  { name: "NDTV India", url: "https://feeds.feedburner.com/ndtvnews-india-news", weight: 0.85, topic: "India" },

  // Explained / analysis (high signal — surfaces the "why")
  { name: "Indian Express Explained", url: "https://indianexpress.com/section/explained/feed/", weight: 1.0, topic: "Explained" },

  // Business / economy
  { name: "The Hindu Business", url: "https://www.thehindu.com/business/feeder/default.rss", weight: 0.95, topic: "Business" },
  { name: "Mint", url: "https://www.livemint.com/rss/news", weight: 0.95, topic: "Business" },
  { name: "Economic Times", url: "https://economictimes.indiatimes.com/rssfeedstopstories.cms", weight: 0.9, topic: "Business" },
  { name: "Economic Times Markets", url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", weight: 0.85, topic: "Business" },

  // World
  { name: "The Hindu World", url: "https://www.thehindu.com/news/international/feeder/default.rss", weight: 0.9, topic: "World" },
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", weight: 0.9, topic: "World" },

  // Sports
  { name: "The Hindu Sport", url: "https://www.thehindu.com/sport/feeder/default.rss", weight: 0.8, topic: "Sports" },
  { name: "Times of India Sports", url: "https://timesofindia.indiatimes.com/rssfeeds/4719148.cms", weight: 0.75, topic: "Sports" },

  // Science / technology
  { name: "The Hindu Sci-Tech", url: "https://www.thehindu.com/sci-tech/feeder/default.rss", weight: 0.8, topic: "Science" },
  { name: "Times of India Tech", url: "https://timesofindia.indiatimes.com/rssfeeds/66949542.cms", weight: 0.75, topic: "Technology" },
];
