// The single source of truth for Shortly's consumer news categories.
// Used by: scrape classification, the public read API, the subscribe function,
// and (mirrored in the website's newsCategories.js) the front-end.
//
// slug  -> stable id used in URLs, per-category JSON filenames, and the DB.
// label -> human label shown in the UI.

export type NewsCategory = { slug: string; label: string };

export const NEWS_CATEGORIES: NewsCategory[] = [
  { slug: "national", label: "National" },
  { slug: "international", label: "International" },
  { slug: "finance", label: "Finance" },
  { slug: "sports", label: "Sports" },
  { slug: "entertainment", label: "Entertainment" },
  { slug: "lifestyle", label: "Lifestyle" },
  { slug: "technology", label: "Technology" },
];

export const CATEGORY_SLUGS = NEWS_CATEGORIES.map((c) => c.slug);
export const CATEGORY_LABELS = NEWS_CATEGORIES.map((c) => c.label);

// Accepts a slug or a label (any case) and returns the canonical slug, or null.
export function normalizeCategory(value: unknown): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  const bySlug = NEWS_CATEGORIES.find((c) => c.slug === raw);
  if (bySlug) return bySlug.slug;
  const byLabel = NEWS_CATEGORIES.find((c) => c.label.toLowerCase() === raw);
  return byLabel ? byLabel.slug : null;
}

export const VALID_DELIVERY_RHYTHMS = ["daily", "weekly", "bi-weekly", "monthly"] as const;
export const VALID_SOURCE_PREFERENCES = ["top", "mixed", "wide"] as const;
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
// Fixed days a bi-weekly subscriber receives editions on.
export const BIWEEKLY_DAYS = ["tue", "fri"] as const;
