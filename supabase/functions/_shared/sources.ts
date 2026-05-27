// News sources for the daily scrape. RSS first - fast, polite, structured.
// Keep the source list intentionally small for predictable fetch times.
export type Source = {
  name: string;
  url: string;
  weight: number;
  topic?: string;
};

export const SOURCES: Source[] = [
  { name: "TOI", url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", weight: 1.0, topic: "India" },
  { name: "ET", url: "https://economictimes.indiatimes.com/rssfeedstopstories.cms", weight: 0.95, topic: "India Business" },
  { name: "The Hindu", url: "https://www.thehindu.com/news/national/feeder/default.rss", weight: 1.0, topic: "India" },
];
