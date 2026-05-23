// News sources for the daily scrape. RSS first — fast, polite, structured.
// Limited to TOI, ET, and The Hindu.
export type Source = {
  name: string;
  url: string;
  weight: number;
  topic?: string;
};

export const SOURCES: Source[] = [
  // Times of India
  { name: "TOI", url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", weight: 1.0, topic: "India" },
  { name: "TOI", url: "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms", weight: 0.95, topic: "India" },
  { name: "TOI", url: "https://timesofindia.indiatimes.com/rssfeeds/1898055.cms", weight: 0.9, topic: "India Business" },
  { name: "TOI", url: "https://timesofindia.indiatimes.com/rssfeeds/66949542.cms", weight: 0.85, topic: "India Tech" },

  // Economic Times
  { name: "ET", url: "https://economictimes.indiatimes.com/rssfeedstopstories.cms", weight: 1.0, topic: "India" },
  { name: "ET", url: "https://economictimes.indiatimes.com/news/india/rssfeeds/81582957.cms", weight: 0.95, topic: "India" },
  { name: "ET", url: "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms", weight: 0.9, topic: "India Business" },
  { name: "ET", url: "https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms", weight: 0.85, topic: "India Tech" },
  { name: "ET", url: "https://economictimes.indiatimes.com/tech/technology/rssfeeds/78570561.cms", weight: 0.85, topic: "India Tech" },

  // The Hindu
  { name: "The Hindu", url: "https://www.thehindu.com/news/national/feeder/default.rss", weight: 1.0, topic: "India" },
  { name: "The Hindu", url: "https://www.thehindu.com/business/feeder/default.rss", weight: 0.9, topic: "India Business" },
];
