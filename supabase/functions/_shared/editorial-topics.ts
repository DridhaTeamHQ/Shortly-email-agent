export type EditorialSource = {
  name: string;
  url: string;
  weight: number;
  kind?: "rss" | "reddit" | "html";
  accepts?: (url: string) => boolean;
};

export type EditorialTopic = {
  slug: "real-estate" | "policy-partner" | "money-matters" | "wellness-daily";
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
    name: "Industry: Real Estate",
    format: "hybrid",
    cadence: "Monday to Saturday",
    description: "Real-estate honesty for Indians: launches, handovers, builder moves, infrastructure and regulation, followed by one evidence-led thesis.",
    selection: "Prioritise national builders and Delhi/NCR, Mumbai/MMR, Bengaluru, Hyderabad, Chennai and Pune. Tier-2 stories qualify only when nationally consequential. The five briefs should cover launch, completion/handover, developer move, infrastructure, and regulation where the source pool allows it.",
    structure: "Return exactly five briefing items of 60-80 words, each with headline, what_happened, why_it_matters and city. Then return one thesis with a 90-110 word summary and 300-500 word detail. Always name the city for a specific project. Define real-estate jargon on first use.",
    voice: "Sceptical of broker hype. Builder claims remain attributed claims. Use numbers only from supplied sources. Include at least one sourced comparison, scenario, or clearly labelled editor inference. Never invent EMI, yield, price or appreciation calculations.",
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
      { name: "Moneycontrol Real Estate", url: moneycontrolLatest, weight: 0.95, accepts: (url) => /moneycontrol\.com\/news\/(business\/real-estate|real-estate)/i.test(url) }
    ]
  },
  "policy-partner": {
    slug: "policy-partner",
    name: "Policy Partner",
    format: "single",
    cadence: "Monday to Saturday",
    description: "Indian policy in plain English: what changed, who it touches, what it means, and what to watch next.",
    selection: "Pick the most consequential development from the last 24 hours touching money, rights, work or daily life for an urban Indian under 35. Prefer primary notifications, then independent legal or legislative analysis. Skip speeches, ceremonies, MoUs, party conflict and internal reshuffles.",
    structure: "Return a 90-110 word standalone summary covering what happened, who is affected and what changes, followed by 300-500 words explaining mechanism, history, critique and what to watch. Include a concrete example, old-versus-new comparison, parallel, or daily-life analogy.",
    voice: "Neutral on parties and sharp on policy design. Translate regulator language into plain English. Present official and critic framing without false balance. Never use 'landmark move', 'historic decision', 'sources said', or 'it remains to be seen'.",
    safety: "Do not add legal conclusions or numerical examples absent from supplied sources. Flag every analogy or extrapolation as editor inference.",
    checklist: [
      "Primary notification or order checked where available.",
      "What changed, who is affected, and effective date are explicit.",
      "Every number and legal claim traces to a source.",
      "Example or comparison is present and understandable.",
      "Political actors are treated neutrally; policy substance is evaluated.",
      "Any inference is flagged for editor verification."
    ],
    sources: [
      { name: "PRS Legislative Research", url: "https://prsindia.org/", weight: 1, kind: "html", accepts: (url) => /prsindia\.org\/(billtrack|policy|theprsblog|parliamenttrack)/i.test(url) },
      { name: "Bar & Bench", url: "https://www.barandbench.com/feed", weight: 0.95 },
      { name: "LiveLaw", url: "https://www.livelaw.in/", weight: 0.95, kind: "html" },
      { name: "Indian Express Explained", url: "https://indianexpress.com/section/explained/feed/", weight: 0.9 },
      { name: "ThePrint Explained", url: "https://theprint.in/category/explainers/", weight: 0.85, kind: "html" },
      { name: "RBI", url: "https://www.rbi.org.in/scripts/RSS.aspx?Id=2000", weight: 1 }
    ]
  },
  "money-matters": {
    slug: "money-matters",
    name: "Money Matters",
    format: "hybrid",
    cadence: "Monday to Saturday",
    description: "Five consequential Indian money developments plus one sharper, source-bound take.",
    selection: "Choose developments changing how an urban Indian aged 22-35 earns, saves, invests or pays tax. Aim for regulation, markets/macro with a real cause, corporate/deal, consumer finance, and scam/enforcement. Skip bare index moves, stock tips and prediction listicles.",
    structure: "Return exactly five briefing items of 60-80 words, each with headline, what_happened and why_it_matters. Then return one take with a 90-110 word summary and 300-500 word detail explaining what mainstream coverage says, what it misses, and what readers should watch.",
    voice: "Readers know the basics. No finfluencer language, product recommendations, stock recommendations, hypothetical tax math, IRRs, EMIs or return calculations. Include a sourced example/comparison or a clearly labelled analogy. Define jargon immediately.",
    safety: "Every issue must end exactly with: This isn't investment advice. We don't know your situation. Talk to a SEBI-registered advisor before acting on anything you read here.",
    checklist: [
      "Five briefs are distinct rather than five versions of one category.",
      "Every number traces to a source or official filing.",
      "No product, fund, stock, IPO or return recommendation appears.",
      "No hypothetical tax, EMI, IRR or capital-gains calculation appears.",
      "A sourced example/comparison or flagged analogy is present.",
      "Investment-advice disclaimer is included verbatim."
    ],
    sources: [
      { name: "Mint Money", url: "https://www.livemint.com/rss/money", weight: 1 },
      { name: "Moneycontrol", url: moneycontrolLatest, weight: 0.95, accepts: (url) => /moneycontrol\.com\/news\/(business|personal-finance)/i.test(url) },
      { name: "Business Standard Finance", url: "https://www.business-standard.com/rss/finance-103.rss", weight: 0.9 },
      { name: "Capitalmind", url: "https://premium.capitalmind.in/feed", weight: 0.9 },
      { name: "Zerodha Varsity", url: "https://zerodha.com/varsity/feed/", weight: 0.85 },
      { name: "RBI", url: "https://www.rbi.org.in/scripts/RSS.aspx?Id=2000", weight: 1 },
      { name: "SEBI", url: "https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=6&ssid=25&smid=0", weight: 1, kind: "html", accepts: (url) => /sebi\.gov\.in\/(media-and-notifications|legal)/i.test(url) },
      { name: "IndiaInvestments Reddit", url: "https://www.reddit.com/r/IndiaInvestments/new.json?limit=20", weight: 0.45, kind: "reddit" },
      { name: "PersonalFinanceIndia Reddit", url: "https://www.reddit.com/r/personalfinanceindia/new.json?limit=20", weight: 0.4, kind: "reddit" }
    ]
  },
  "wellness-daily": {
    slug: "wellness-daily",
    name: "The Wellness Daily",
    format: "single",
    cadence: "Monday to Saturday",
    description: "A five-minute evidence-led wellness advisory for desk-bound Indian working professionals aged 22-35.",
    selection: "Follow the locked rotation by India day: Monday mental health/work; Tuesday movement/fitness; Wednesday nutrition; Thursday sleep/recovery/focus; Friday mental health/work from a different angle; Saturday habit experiment, Q&A or category review. Choose one study, claim to debunk, or reader confusion as the anchor.",
    structure: "Return a 90-110 word standalone summary stating the claim, evidence quality and Indian translation, followed by 300-500 words unpacking evidence, caveats and a practical Indian-context takeaway. Add one Indian salary, food, cost, climate, commute, gym-access or workplace translation, but never invent a number.",
    voice: "Evidence-led, suspicious of wellness marketing, kind but unsentimental. Say when evidence is thin. No hack, game-changer, the truth about, let's dive in, clean/dirty food, moralising, before/after framing, body-part focus or exclamation marks. Use at most one metaphor.",
    safety: "Never provide drug doses, supplement brands, calorie targets, step-count goals or weight-loss numbers. Mental-health pieces must end with the iCall line. Pieces mentioning a medical condition must include the medical-advice line.",
    checklist: [
      "Evidence strength is stated honestly.",
      "Indian context is specific and source-bound.",
      "No doses, supplement brands, calorie targets, step goals or weight-loss targets.",
      "No influencer language, food moralising or before/after framing.",
      "Mental-health helpline line is included when applicable.",
      "Medical-advice line is included when a condition is mentioned."
    ],
    sources: [
      { name: "Washington Post Well+Being", url: "https://www.washingtonpost.com/wellness/", weight: 1, kind: "html", accepts: (url) => /washingtonpost\.com\/wellness\//i.test(url) },
      { name: "The Guardian Wellness", url: "https://www.theguardian.com/lifeandstyle/health-and-wellbeing/rss", weight: 0.95 },
      { name: "Harvard Business Review", url: "https://feeds.hbr.org/harvardbusiness", weight: 0.9 },
      { name: "IndianWorkplace Reddit", url: "https://www.reddit.com/r/IndianWorkplace/new.json?limit=20", weight: 0.45, kind: "reddit" },
      { name: "AskDocs Reddit", url: "https://www.reddit.com/r/AskDocs/new.json?limit=20", weight: 0.35, kind: "reddit" },
      { name: "Fitness Reddit", url: "https://www.reddit.com/r/Fitness/new.json?limit=20", weight: 0.3, kind: "reddit" },
      { name: "Nutrition Reddit", url: "https://www.reddit.com/r/nutrition/new.json?limit=20", weight: 0.3, kind: "reddit" }
    ]
  }
};

export function getEditorialTopic(slug: string): EditorialTopic | null {
  return EDITORIAL_TOPICS[slug] ?? null;
}
