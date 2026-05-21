// News sources for the daily scrape. RSS first — fast, polite, structured.
// Weights bias the top-50 ranking toward higher-trust outlets.
export type Source = {
  name: string;
  url: string;
  weight: number;
  topic?: string;
};

export const SOURCES: Source[] = [
  { name: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml", weight: 1.0, topic: "World" },
  { name: "BBC", url: "https://feeds.bbci.co.uk/news/business/rss.xml", weight: 0.9, topic: "Business" },
  { name: "Reuters", url: "https://www.reutersagency.com/feed/?best-topics=top-news&post_type=best", weight: 1.0, topic: "World" },
  { name: "AP", url: "https://feeds.apnews.com/rss/apf-topnews", weight: 1.0, topic: "World" },
  { name: "AP", url: "https://feeds.apnews.com/rss/apf-business", weight: 0.9, topic: "Business" },
  { name: "NYT", url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", weight: 1.0, topic: "World" },
  { name: "NYT", url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml", weight: 0.9, topic: "Business" },
  { name: "NYT", url: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml", weight: 0.85, topic: "Technology" }
];
