// News sources for the daily scrape. RSS first — fast, polite, structured.
// Weights bias the top-50 ranking toward higher-trust outlets.
export type Source = {
  name: string;
  url: string;
  weight: number;
  topic?: string;
};

export const SOURCES: Source[] = [
  // World
  { name: "Shortly", url: "https://feeds.bbci.co.uk/news/world/rss.xml", weight: 1.0, topic: "World" },
  { name: "Shortly", url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", weight: 1.0, topic: "World" },

  // Business
  { name: "Shortly", url: "https://feeds.bbci.co.uk/news/business/rss.xml", weight: 0.9, topic: "Business" },
  { name: "Shortly", url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml", weight: 0.9, topic: "Business" },

  // Technology
  { name: "Shortly", url: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml", weight: 0.85, topic: "Technology" },

  // India — National
  { name: "Shortly", url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", weight: 1.0, topic: "India" },
  { name: "Shortly", url: "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms", weight: 0.95, topic: "India" },
  { name: "Shortly", url: "https://www.thehindu.com/news/national/feeder/default.rss", weight: 1.0, topic: "India" },
  { name: "Shortly", url: "https://feeds.feedburner.com/ndtvnews-top-stories", weight: 0.95, topic: "India" },
  { name: "Shortly", url: "https://indianexpress.com/section/india/feed/", weight: 0.9, topic: "India" },

  // India — Business
  { name: "Shortly", url: "https://timesofindia.indiatimes.com/rssfeeds/1898055.cms", weight: 0.9, topic: "India Business" },
  { name: "Shortly", url: "https://www.thehindu.com/business/feeder/default.rss", weight: 0.85, topic: "India Business" },

  // India — Technology
  { name: "Shortly", url: "https://timesofindia.indiatimes.com/rssfeeds/66949542.cms", weight: 0.85, topic: "India Tech" },
];
