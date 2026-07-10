export type EditorialSource = {
  name: string;
  url: string;
  weight: number;
  kind?: "rss" | "reddit" | "html";
  accepts?: (url: string) => boolean;
};

export type EditorialTopic = {
  slug: "real-estate" | "automobile" | "health-wellness" | "tech-ai" | "markets-startups";
  name: string;
  format: "single" | "hybrid";
  cadence: string;
  description: string;
  selection: string;
  structure: string;
  voice: string;
  safety: string;
  checklist: string[];
  sources: EditorialSource[];
};

const moneycontrolLatest = "https://www.moneycontrol.com/rss/latestnews.xml";

export const EDITORIAL_TOPICS: Record<string, EditorialTopic> = {
  "real-estate": {
    slug: "real-estate",
    name: "Real Estate",
    format: "single",
    cadence: "Monday to Saturday",
    description: "Real-estate honesty for Indians: launches, handovers, builder moves, infrastructure and regulation, followed by one evidence-led thesis.",
    selection: "Prioritise national builders and Delhi/NCR, Mumbai/MMR, Bengaluru, Hyderabad, Chennai and Pune. Tier-2 stories qualify only when nationally consequential. Select an individual strong story to analyse in depth — a launch, completion/handover, developer move, infrastructure development, or regulatory change — where the source pool allows it.",
    structure: "Return ONE case-study article. Provide a headline; a standalone summary of 90-130 words that says what happened and why it matters (readable on its own, without the detail); and a 300-500 word analytical detail. The detail must open on the market dynamic or stake (NOT restate the summary's opening sentence), then explain the mechanism, context and tension, include at least one sourced comparison or clearly-flagged editor inference, and close on what to watch next. Do NOT include a templated 'this piece draws on … read the full piece here' credit line; attribute the source publication naturally in prose (the source links are stored and shown separately). Always name the city for a specific project. Define real-estate jargon (FSI, RERA, carpet vs super built-up, OC/CC) on first use only.",
    voice: "Sceptical of broker hype. Builder and developer claims remain attributed claims, framed in the source's own language (if the source said 'premium' or 'affordable housing', use that). Use numbers only from supplied sources. Include at least one sourced comparison, scenario, or clearly labelled editor inference. Never invent EMI, yield, price or appreciation calculations. No exclamation marks.",
    safety: "This is editorial synthesis, not original reporting. Every factual claim must be traceable to a supplied source URL.",
    checklist: [
      "Original article links verified and accessible.",
      "City named for every specific project mentioned.",
      "Every number traced back to the source.",
      "Builder/developer claims framed in the source's own language.",
      "Any analogy or parallel flagged as agent inference.",
      "No invented projections, EMIs, or yield calculations."
    ],
    sources: [
      { name: "ET Realty", url: "https://realty.economictimes.indiatimes.com/rss/topstories", weight: 1 },
      { name: "ET Realty Residential", url: "https://realty.economictimes.indiatimes.com/rss/residential", weight: 0.95 },
      { name: "ET Realty Commercial", url: "https://realty.economictimes.indiatimes.com/rss/commercial", weight: 0.9 },
      { name: "Moneycontrol Real Estate", url: moneycontrolLatest, weight: 0.9, accepts: (url) => /moneycontrol\.com\/news\/(business\/real-estate|real-estate)/i.test(url) },
      { name: "Financial Express Real Estate", url: "https://www.financialexpress.com/money/real-estate/feed/", weight: 0.85 },
      { name: "Hindustan Times Real Estate", url: "https://www.hindustantimes.com/feeds/rss/real-estate/rssfeed.xml", weight: 0.8 },
      // NOTE: TOI feed 54829575 is TOI's CRICKET feed, not real estate — it was
      // flooding this pool with sports. Removed; do not re-add unverified TOI ids.
      { name: "Business Standard Real Estate", url: "https://www.business-standard.com/rss/industry/real-estate-10303.rss", weight: 0.8 }
    ]
  },
  "automobile": {
    slug: "automobile",
    name: "Automobile",
    format: "single",
    cadence: "Monday to Saturday",
    description: "India's auto industry decoded: launches, EV transition, sales trends, policy moves and safety — one evidence-led deep dive a day.",
    selection: "Choose a development from the Indian automobile world that changes what people drive, what it costs, or how the industry is shifting: a launch or facelift with real market stakes, EV/charging-infrastructure moves, monthly sales trends with a cause, safety ratings and recalls, or policy (FAME, PLI, emission norms, import duties). Global stories qualify only when they clearly touch the Indian market. Pick an individual strong story to analyse in depth where the source pool allows it. Skip spy shots, rumour round-ups, and bare spec-sheet reposts.",
    structure: "Return ONE case-study article. Provide a headline; a standalone summary of 90-130 words that says what happened and why it matters (readable on its own, without the detail); and a 300-500 word analytical detail. The detail must open on the market dynamic or stake (NOT restate the summary's opening sentence), then explain the mechanism, competitive context and tension, include at least one sourced comparison or clearly-flagged editor inference, and close on what to watch next. Attribute the source publication naturally in prose. Define auto jargon (ADAS, PLI, CAFE norms, localisation, GNCAP/BNCAP) on first use only.",
    voice: "Sceptical of manufacturer hype. OEM claims about range, mileage, delivery timelines and 'segment-first' features remain attributed claims in the source's own language. Use numbers only from supplied sources — never invent prices, range figures, sales projections or EMI calculations. Include at least one sourced comparison, scenario, or clearly labelled editor inference. No exclamation marks.",
    safety: "This is editorial synthesis, not original reporting. Every factual claim must be traceable to a supplied source URL. Never present a claimed range/mileage figure as tested fact.",
    checklist: [
      "Original article links verified and accessible.",
      "Every number (price, range, sales, timeline) traced back to the source.",
      "OEM claims framed as attributed claims in the source's own language.",
      "Competitive or historical comparison present and sourced or flagged as inference.",
      "No invented prices, projections or EMI calculations.",
      "Auto jargon defined on first use."
    ],
    sources: [
      { name: "ET Auto", url: "https://auto.economictimes.indiatimes.com/rss/topstories", weight: 1 },
      { name: "ET Auto Passenger Vehicles", url: "https://auto.economictimes.indiatimes.com/rss/passenger-vehicle/cars", weight: 0.9 },
      { name: "Moneycontrol Auto", url: moneycontrolLatest, weight: 0.9, accepts: (url) => /moneycontrol\.com\/news\/(business\/)?(automobile|auto)/i.test(url) },
      { name: "Financial Express Auto", url: "https://www.financialexpress.com/auto/feed/", weight: 0.9 },
      { name: "Autocar India", url: "https://www.autocarindia.com/rss/news", weight: 0.85 },
      { name: "Autocar Professional", url: "https://www.autocarpro.in/rss/news", weight: 0.85 },
      { name: "Times of India Auto", url: "https://timesofindia.indiatimes.com/rssfeeds/74317216.cms", weight: 0.8 },
      { name: "Business Standard Auto", url: "https://www.business-standard.com/rss/industry/auto-21601.rss", weight: 0.75 },
      { name: "CarWale Reddit", url: "https://www.reddit.com/r/CarsIndia/new.json?limit=20", weight: 0.35, kind: "reddit" }
    ]
  },
  "health-wellness": {
    slug: "health-wellness",
    name: "Health & Wellness",
    format: "single",
    cadence: "Monday to Saturday",
    description: "Evidence-led health and wellness for desk-bound Indian working professionals: one deeper practical advisory a day.",
    selection: "Follow the locked rotation by India day: Monday mental health/work; Tuesday movement/fitness; Wednesday nutrition; Thursday sleep/recovery/focus; Friday mental health/work from a different angle; Saturday habit experiment, Q&A or category review. Choose one study, claim to debunk, or reader confusion as the anchor and analyse that individual strong story in depth where the source pool allows it.",
    structure: "Return ONE advisory article. Provide a headline; a standalone summary of 90-130 words stating the claim, the evidence quality and the Indian translation, and why it matters (readable on its own, without the detail); and a 300-500 word analytical detail. The detail must open on the wellness dynamic or stake (NOT restate the summary's opening sentence), then unpack the evidence and caveats, include at least one Indian salary, food, cost, climate, commute, gym-access or workplace translation as a sourced comparison or clearly-flagged editor inference (never invent a number), and close on a practical Indian-context takeaway and what to watch.",
    voice: "Evidence-led, suspicious of wellness marketing, kind but unsentimental. Say when evidence is thin. No hack, game-changer, the truth about, let's dive in, clean/dirty food, moralising, before/after framing, body-part focus or exclamation marks. Use at most one metaphor.",
    safety: "Never provide drug doses, supplement brands, calorie targets, step-count goals or weight-loss numbers. No 'clean vs dirty' food language, no before/after framing, no body-part-focused content. A mental-health piece MUST end with this exact line: \"If you're struggling, iCall is a free confidential helpline: 9152987821.\" Any piece mentioning a medical condition MUST include this exact line: \"This isn't medical advice. See a doctor for anything concerning you.\"",
    checklist: [
      "Evidence strength is stated honestly.",
      "Indian context is specific and source-bound.",
      "No doses, supplement brands, calorie targets, step goals or weight-loss targets.",
      "No influencer language, food moralising or before/after framing.",
      "Mental-health helpline line is included when applicable.",
      "Medical-advice line is included when a condition is mentioned."
    ],
    sources: [
      { name: "The Hindu Health", url: "https://www.thehindu.com/sci-tech/health/feeder/default.rss", weight: 1 },
      { name: "Indian Express Health", url: "https://indianexpress.com/section/lifestyle/health/feed/", weight: 0.95 },
      { name: "Hindustan Times Lifestyle", url: "https://www.hindustantimes.com/feeds/rss/lifestyle/rssfeed.xml", weight: 0.9 },
      { name: "Times of India Health", url: "https://timesofindia.indiatimes.com/rssfeeds/3908999.cms", weight: 0.9 },
      { name: "The Guardian Wellness", url: "https://www.theguardian.com/lifeandstyle/health-and-wellbeing/rss", weight: 0.8 },
      { name: "Harvard Business Review", url: "https://feeds.hbr.org/harvardbusiness", weight: 0.75 },
      { name: "IndianWorkplace Reddit", url: "https://www.reddit.com/r/IndianWorkplace/new.json?limit=20", weight: 0.45, kind: "reddit" },
      { name: "AskDocs Reddit", url: "https://www.reddit.com/r/AskDocs/new.json?limit=20", weight: 0.35, kind: "reddit" },
      { name: "Fitness Reddit", url: "https://www.reddit.com/r/Fitness/new.json?limit=20", weight: 0.3, kind: "reddit" },
      { name: "Nutrition Reddit", url: "https://www.reddit.com/r/nutrition/new.json?limit=20", weight: 0.3, kind: "reddit" }
    ]
  },
  "tech-ai": {
    slug: "tech-ai",
    name: "Tech & AI",
    format: "single",
    cadence: "Monday to Saturday",
    description: "Technology and AI that actually touches Indian users, workers and builders — one sharp, hype-free deep dive a day.",
    selection: "Choose a development from the last 48 hours in technology or AI that changes what an Indian professional uses, earns with, or should understand: AI model/product launches with real capability shifts, platform and policy moves (IT rules, DPDP, app bans, net neutrality), Indian tech company and product news, chips/infrastructure, or consequential global tech with a clear Indian angle. Pick an individual strong story to analyse in depth where the source pool allows it. Skip gadget spec reposts, crypto price moves, and 'AI will change everything' thinkpieces with no concrete development.",
    structure: "Return ONE case-study article. Provide a headline; a standalone summary of 90-130 words that says what happened and why it matters (readable on its own, without the detail); and a 300-500 word analytical detail. The detail must open on the capability, market or power dynamic at stake (NOT restate the summary's opening sentence), then explain the mechanism, context and tension, include at least one sourced comparison or clearly-flagged editor inference, and close on what to watch next. Attribute the source publication naturally in prose. Define tech jargon (LLM, inference, API, open weights, DPDP) on first use only.",
    voice: "Hype-immune. Vendor benchmarks, 'human-level' claims and adoption numbers remain attributed claims in the source's own language. Use numbers only from supplied sources. Distinguish what a system is demonstrated to do from what its maker says it will do. Include at least one sourced comparison, scenario, or clearly labelled editor inference. No exclamation marks. Banned phrases: 'game-changer', 'revolutionary', 'the AI revolution', 'in the age of AI'.",
    safety: "This is editorial synthesis, not original reporting. Every factual claim must be traceable to a supplied source URL. Never recommend specific stocks or tokens; never present vendor benchmarks as independent results.",
    checklist: [
      "Original article links verified and accessible.",
      "Every number and benchmark traced back to the source.",
      "Vendor claims framed as attributed claims in the source's own language.",
      "Demonstrated capability separated from promised capability.",
      "A sourced comparison or flagged inference is present.",
      "Tech jargon defined on first use."
    ],
    sources: [
      { name: "ET Tech", url: "https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms", weight: 1 },
      { name: "Indian Express Technology", url: "https://indianexpress.com/section/technology/feed/", weight: 0.9 },
      { name: "Moneycontrol Technology", url: moneycontrolLatest, weight: 0.9, accepts: (url) => /moneycontrol\.com\/news\/(technology|business\/startup)/i.test(url) },
      { name: "MediaNama", url: "https://www.medianama.com/feed/", weight: 0.9 },
      { name: "Inc42", url: "https://inc42.com/feed/", weight: 0.85 },
      { name: "TechCrunch", url: "https://techcrunch.com/feed/", weight: 0.85 },
      { name: "The Verge", url: "https://www.theverge.com/rss/index.xml", weight: 0.8 },
      { name: "Times of India Tech", url: "https://timesofindia.indiatimes.com/rssfeeds/66949542.cms", weight: 0.75 },
      { name: "Artificial Reddit", url: "https://www.reddit.com/r/artificial/new.json?limit=20", weight: 0.35, kind: "reddit" },
      { name: "DevelopersIndia Reddit", url: "https://www.reddit.com/r/developersIndia/new.json?limit=20", weight: 0.35, kind: "reddit" }
    ]
  },
  "markets-startups": {
    slug: "markets-startups",
    name: "Markets & Startups",
    format: "single",
    cadence: "Monday to Saturday",
    description: "Indian markets and the startup economy: one consequential development a day, analysed with a sharper, source-bound take.",
    selection: "Choose a development that changes how an urban Indian aged 22-35 earns, saves, invests, or reads the startup economy. Pick an individual strong story to analyse in depth — from markets/macro with a real cause, regulation (SEBI/RBI), IPOs and listings, startup funding rounds, shutdowns and pivots with real stakes, corporate/deal activity, or scam/enforcement. Skip bare index moves, stock tips, prediction listicles, and funding announcements with no analysable substance.",
    structure: "Return ONE take article. Provide a headline; a standalone summary of 90-130 words that says what happened and why it matters (readable on its own, without the detail); and a 300-500 word analytical detail. The detail must open on the money or market dynamic at stake (NOT restate the summary's opening sentence), then explain what mainstream coverage says and what it misses, include at least one sourced example/comparison or clearly-flagged editor inference, and close on what readers should watch next.",
    voice: "Readers know the basics. Never recommend a specific product, fund, stock or IPO — discuss categories and frameworks, not picks. Never compute hypothetical tax, IRR, EMI, capital-gains or return numbers; every number traces to a source. Valuations and funding amounts remain attributed claims. Include a sourced example/comparison or a clearly labelled analogy; define jargon immediately. Banned phrases: 'wealth-building', 'passive income', 'compounding miracle', 'money mindset', 'financial freedom', 'your future self will thank you', and any 'get rich' framing. No celebrity-investor name-dropping (Buffett, Munger, Jhunjhunwala) unless their actual decision is the story. No exclamation marks.",
    safety: "Every issue must end exactly with: This isn't investment advice. We don't know your situation. Talk to a SEBI-registered advisor before acting on anything you read here.",
    checklist: [
      "Story is a single strong development analysed in depth rather than a shallow round-up.",
      "Every number traces to a source or official filing.",
      "No product, fund, stock, IPO or return recommendation appears.",
      "No hypothetical tax, EMI, IRR or capital-gains calculation appears.",
      "A sourced example/comparison or flagged analogy is present.",
      "Investment-advice disclaimer is included verbatim."
    ],
    sources: [
      { name: "Mint Money", url: "https://www.livemint.com/rss/money", weight: 1 },
      { name: "Mint Markets", url: "https://www.livemint.com/rss/markets", weight: 0.95 },
      { name: "Moneycontrol", url: moneycontrolLatest, weight: 0.95, accepts: (url) => /moneycontrol\.com\/news\/(business|personal-finance)/i.test(url) },
      { name: "BusinessLine Markets", url: "https://www.thehindubusinessline.com/markets/feeder/default.rss", weight: 0.9 },
      { name: "BusinessLine Banking", url: "https://www.thehindubusinessline.com/money-and-banking/feeder/default.rss", weight: 0.9 },
      { name: "ET Markets", url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", weight: 0.9 },
      { name: "Inc42", url: "https://inc42.com/feed/", weight: 0.9 },
      { name: "Entrackr", url: "https://entrackr.com/feed/", weight: 0.9 },
      { name: "YourStory", url: "https://yourstory.com/feed", weight: 0.8 },
      { name: "ET Wealth", url: "https://economictimes.indiatimes.com/wealth/rssfeeds/837555174.cms", weight: 0.85 },
      { name: "Capitalmind", url: "https://premium.capitalmind.in/feed", weight: 0.85 },
      { name: "RBI", url: "https://www.rbi.org.in/scripts/RSS.aspx?Id=2000", weight: 1 },
      { name: "SEBI", url: "https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=6&ssid=25&smid=0", weight: 1, kind: "html", accepts: (url) => /sebi\.gov\.in\/(media-and-notifications|legal)/i.test(url) },
      { name: "IndiaInvestments Reddit", url: "https://www.reddit.com/r/IndiaInvestments/new.json?limit=20", weight: 0.45, kind: "reddit" },
      { name: "StartUpIndia Reddit", url: "https://www.reddit.com/r/StartUpIndia/new.json?limit=20", weight: 0.4, kind: "reddit" }
    ]
  }
};

export function getEditorialTopic(slug: string): EditorialTopic | null {
  return EDITORIAL_TOPICS[slug] ?? null;
}
