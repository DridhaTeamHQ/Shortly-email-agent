// News sources for the daily scrape. RSS first — fast, polite, structured.
// Weights bias the top-50 ranking toward higher-trust outlets.
export type Source = {
  name: string;
  url: string;
  weight: number;
  topic?: string;
};

export const SOURCES: Source[] = [
  // India — National
  { name: "Shortly", url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", weight: 1.0, topic: "India" },
  { name: "Shortly", url: "https://www.thehindu.com/news/national/feeder/default.rss", weight: 1.0, topic: "India" },
  { name: "Shortly", url: "https://feeds.feedburner.com/ndtvnews-india-news", weight: 0.95, topic: "India" },
  { name: "Shortly", url: "https://indianexpress.com/section/india/feed/", weight: 0.95, topic: "India" },
  { name: "Shortly", url: "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml", weight: 0.9, topic: "India" },

  // World — via Indian outlets' international desks
  { name: "Shortly", url: "https://www.thehindu.com/news/international/feeder/default.rss", weight: 0.9, topic: "World" },
  { name: "Shortly", url: "https://feeds.feedburner.com/ndtvnews-world-news", weight: 0.9, topic: "World" },
  { name: "Shortly", url: "https://indianexpress.com/section/world/feed/", weight: 0.85, topic: "World" },
  { name: "Shortly", url: "https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml", weight: 0.85, topic: "World" },

  // India — Business / Markets
  { name: "Shortly", url: "https://economictimes.indiatimes.com/rssfeedstopstories.cms", weight: 0.95, topic: "India Business" },
  { name: "Shortly", url: "https://www.livemint.com/rss/markets", weight: 0.9, topic: "India Business" },
  { name: "Shortly", url: "https://www.business-standard.com/rss/home_page_top_stories.rss", weight: 0.9, topic: "India Business" },
  { name: "Shortly", url: "https://www.thehindu.com/business/feeder/default.rss", weight: 0.85, topic: "India Business" },
  { name: "Shortly", url: "https://indianexpress.com/section/business/feed/", weight: 0.85, topic: "India Business" },

  // India — Technology
  { name: "Shortly", url: "https://indianexpress.com/section/technology/feed/", weight: 0.85, topic: "India Tech" },
  { name: "Shortly", url: "https://gadgets360.com/rss/feeds", weight: 0.8, topic: "India Tech" },
];
