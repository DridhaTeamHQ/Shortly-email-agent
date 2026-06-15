export type CorporateCaseSource = {
  name: "The Ken" | "Inc42" | "Moneycontrol" | "ET Prime";
  url: string;
  weight: number;
  accepts?: (url: string) => boolean;
};

export const CORPORATE_CASE_SOURCES: CorporateCaseSource[] = [
  { name: "The Ken", url: "https://the-ken.com/feed/", weight: 1 },
  { name: "Inc42", url: "https://inc42.com/feed/", weight: 0.95 },
  {
    name: "Moneycontrol",
    url: "https://www.moneycontrol.com/rss/latestnews.xml",
    weight: 0.9,
    accepts: (url) => url.includes("moneycontrol.com/news/business/") || url.includes("moneycontrol.com/news/photos/business/")
  },
  { name: "ET Prime", url: "https://economictimes.indiatimes.com/prime/rssfeeds/837555174.cms", weight: 0.95 }
];
