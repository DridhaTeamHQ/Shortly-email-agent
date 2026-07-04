export type CorporateCaseSource = {
  name: string;
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
  { name: "ET Prime", url: "https://economictimes.indiatimes.com/prime/rssfeeds/837555174.cms", weight: 0.95 },
  // Added 2026-06-30: free, mostly full-text Indian business/startup feeds to widen the
  // candidate pool. The Ken / ET Prime are paywalled and often expose too little text,
  // so most runs found only one usable case; these free feeds give Readability real
  // article bodies to work with. Per-source fetch errors are tolerated by collectCandidates.
  { name: "YourStory", url: "https://yourstory.com/feed", weight: 0.85 },
  { name: "Mint Companies", url: "https://www.livemint.com/rss/companies", weight: 0.9 },
  { name: "ET Industry", url: "https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms", weight: 0.85 },
  { name: "BusinessLine Companies", url: "https://www.thehindubusinessline.com/companies/feeder/default.rss", weight: 0.85 },
  { name: "Moneycontrol Business", url: "https://www.moneycontrol.com/rss/business.xml", weight: 0.85 }
];
