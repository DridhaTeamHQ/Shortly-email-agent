import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import {
  normalizeCategory as normalizeNewsCategory,
  CATEGORY_SLUGS,
  VALID_DELIVERY_RHYTHMS,
  VALID_SOURCE_PREFERENCES,
  WEEKDAYS,
} from "../_shared/news-categories.ts";

// ---------- legacy plan model (kept for the old QA dashboard form) ----------
const VALID_TOPICS = new Set([
  "daily-wrap",
  "corporate-case",
  "real-estate",
  "policy-partner",
  "money-matters",
  "wellness-daily"
]);

const VALID_PLANS = new Set(["daily-wrap", "category-case", "wrap-category", "case-only"]);
const VALID_CATEGORIES = new Set(["Real Estate", "Policy Partner", "Money Matters", "Wellness Daily", "Corporate Case"]);
const CATEGORY_TO_SLUG: Record<string, string> = {
  "Real Estate": "real-estate",
  "Policy Partner": "policy-partner",
  "Money Matters": "money-matters",
  "Wellness Daily": "wellness-daily",
  "Corporate Case": "corporate-case"
};

function normalizePlan(value: unknown): string {
  const plan = String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  return VALID_PLANS.has(plan) ? plan : "daily-wrap";
}

function normalizePlanCategory(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return [...VALID_CATEGORIES].find((cat) => cat.toLowerCase() === raw.toLowerCase()) ?? null;
}

function topicsForPlan(plan: string, category: string | null): string[] {
  if (plan === "daily-wrap" || !category) return ["daily-wrap"];
  const slug = CATEGORY_TO_SLUG[category];
  if (plan === "wrap-category") return ["daily-wrap", slug];
  return [slug];
}

function normalizeTopics(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[;,|]/) : [];
  const topics = source
    .map((item) => String(item).trim().toLowerCase())
    .map((item) => item.replace(/[\s_]+/g, "-"))
    .map((item) => {
      if (["daily", "daily-wrap", "shortly", "shortly-daily-wrap"].includes(item)) return "daily-wrap";
      if (["corporate", "corporate-case", "case-study"].includes(item)) return "corporate-case";
      if (["real-estate", "realestate", "property"].includes(item)) return "real-estate";
      if (["policy", "policy-partner"].includes(item)) return "policy-partner";
      if (["money", "money-matters", "finance"].includes(item)) return "money-matters";
      if (["wellness", "wellness-daily", "health"].includes(item)) return "wellness-daily";
      return item;
    })
    .filter((item) => VALID_TOPICS.has(item));
  return [...new Set(topics.length ? topics : ["daily-wrap"])];
}

// ---------- website "Build your edition" form -> topics + best-fit plan ----------
// Maps the website category slugs (general + the topic categories) to the agent's
// topic slugs, so the dashboard shows them and the sender can reach the reader.
const WEBSITE_CATEGORY_TO_TOPIC: Record<string, string> = {
  "general": "daily-wrap", "daily-wrap": "daily-wrap", "daily": "daily-wrap",
  "corporate-case": "corporate-case", "case-studies": "corporate-case", "case-study": "corporate-case",
  "real-estate": "real-estate", "realestate": "real-estate",
  "policy-partner": "policy-partner", "policy": "policy-partner",
  "money-matters": "money-matters", "money": "money-matters",
  "wellness-daily": "wellness-daily", "wellness": "wellness-daily",
};
const TOPIC_TO_CATEGORY: Record<string, string> = {
  "real-estate": "Real Estate", "policy-partner": "Policy Partner",
  "money-matters": "Money Matters", "wellness-daily": "Wellness Daily", "corporate-case": "Corporate Case",
};

function topicsFromCategories(value: unknown): string[] {
  const src = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[;,|]/) : [];
  const mapped = src
    .map((x) => String(x).trim().toLowerCase().replace(/[\s_]+/g, "-"))
    .map((x) => WEBSITE_CATEGORY_TO_TOPIC[x])
    .filter((x): x is string => Boolean(x) && VALID_TOPICS.has(x));
  return [...new Set(mapped)];
}

function planCategoryForTopics(topics: string[]): { plan: string; category: string | null } {
  const cats = topics.filter((t) => ["real-estate", "policy-partner", "money-matters", "wellness-daily"].includes(t));
  const hasWrap = topics.includes("daily-wrap");
  const hasCase = topics.includes("corporate-case");
  let plan = "daily-wrap";
  if (cats.length && hasCase) plan = "category-case";
  else if (cats.length) plan = "wrap-category";
  else if (hasCase) plan = "case-only";
  else if (hasWrap) plan = "daily-wrap";
  const category = cats.length ? TOPIC_TO_CATEGORY[cats[0]] : (plan === "case-only" ? "Corporate Case" : null);
  return { plan, category };
}

// ---------- new consumer model (the website subscribe form) ----------
function normalizeRhythm(value: unknown): string {
  const r = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  const mapped = r === "biweekly" ? "bi-weekly" : r;
  return (VALID_DELIVERY_RHYTHMS as readonly string[]).includes(mapped) ? mapped : "daily";
}

function normalizeDays(value: unknown): string[] {
  const src = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
  const out = src
    .map((d) => String(d).trim().toLowerCase().slice(0, 3))
    .filter((d) => (WEEKDAYS as readonly string[]).includes(d));
  return [...new Set(out)];
}

function normalizeNewsCategories(value: unknown): string[] {
  const src = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,|]/) : [];
  const lowered = src.map((x) => String(x).trim().toLowerCase());
  if (lowered.includes("all")) return [...CATEGORY_SLUGS];
  const out = src.map((x) => normalizeNewsCategory(x)).filter((x): x is string => Boolean(x));
  return [...new Set(out)];
}

function normalizeSourcePreference(value: unknown): string {
  const s = String(value ?? "").trim().toLowerCase();
  const mapped = s.startsWith("top") ? "top" : s.startsWith("mixed") ? "mixed" : s.startsWith("wide") ? "wide" : s;
  return (VALID_SOURCE_PREFERENCES as readonly string[]).includes(mapped) ? mapped : "top";
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  if (request.method === "GET") {
    const { data, error } = await supabase
      .from("subscribers")
      .select("id,email,full_name,phone_number,topics,plan,category,rhythm,send_days,news_categories,source_preference,status,created_at")
      .order("created_at", { ascending: false });
    if (error) return json({ error: error.message }, 500);
    return json({ subscribers: data });
  }

  if (request.method === "POST") {
    const body = await request.json();
    const { action } = body;

    // NEW consumer subscribe (website form): rhythm + categories[] + source pref.
    if (action === "subscribe") {
      const { email, name, full_name } = body;
      if (!email?.trim() || !String(email).includes("@")) return json({ error: "A valid email is required." }, 400);
      const normalizedEmail = email.trim().toLowerCase();
      const normalizedName = String(name ?? full_name ?? "").trim() || null;

      const rhythm = normalizeRhythm(body.rhythm);
      const sendDays = rhythm === "weekly" ? normalizeDays(body.send_days ?? body.days) : [];
      if (rhythm === "weekly" && sendDays.length === 0) {
        return json({ error: "Pick at least one day for weekly delivery." }, 400);
      }
      // Website categories -> topic slugs (dashboard + sender) + best-fit plan/category.
      const topics = topicsFromCategories(body.categories ?? body.topics ?? body.news_categories);
      if (topics.length === 0) {
        return json({ error: "Select at least one category." }, 400);
      }
      const { plan, category } = planCategoryForTopics(topics);
      const sourcePreference = normalizeSourcePreference(body.source_preference ?? body.source_pref);

      const { data: existing, error: existingError } = await supabase
        .from("subscribers")
        .select("id,status")
        .eq("email", normalizedEmail)
        .maybeSingle();
      if (existingError) return json({ error: existingError.message }, 500);

      const record: Record<string, unknown> = {
        plan,
        category,
        topics,
        rhythm,
        send_days: sendDays,
        source_preference: sourcePreference,
        status: "subscribed",
        updated_at: new Date().toISOString(),
      };
      if (normalizedName) record.full_name = normalizedName;

      if (existing?.id) {
        const { error } = await supabase.from("subscribers").update(record).eq("id", existing.id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, existing: true, resubscribed: existing.status !== "subscribed" });
      }

      const { error } = await supabase
        .from("subscribers")
        .insert({ email: normalizedEmail, ...record });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, created: true });
    }

    if (action === "add") {
      const { email, full_name, phone_number } = body;
      if (!email?.trim()) return json({ error: "email is required" }, 400);
      const normalizedEmail = email.trim().toLowerCase();
      const normalizedName = full_name?.trim() || null;
      const normalizedPhone = phone_number?.trim() || null;

      const plan = normalizePlan(body.plan);
      const category = plan === "daily-wrap" ? null : normalizePlanCategory(body.category);
      if (plan !== "daily-wrap" && !category) {
        return json({ error: "Please choose a category for this plan." }, 400);
      }
      const normalizedTopics = topicsForPlan(plan, category);

      const { data: existing, error: existingError } = await supabase
        .from("subscribers")
        .select("id,status,full_name,phone_number,topics")
        .eq("email", normalizedEmail)
        .maybeSingle();
      if (existingError) return json({ error: existingError.message }, 500);

      if (existing?.id) {
        const patch: Record<string, unknown> = {
          status: "subscribed",
          plan,
          category,
          topics: normalizedTopics,
          updated_at: new Date().toISOString()
        };
        if (normalizedName) patch.full_name = normalizedName;
        if (normalizedPhone) patch.phone_number = normalizedPhone;
        const { error } = await supabase
          .from("subscribers")
          .update(patch)
          .eq("id", existing.id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, existing: true, resubscribed: existing.status !== "subscribed" });
      }

      const { error } = await supabase
        .from("subscribers")
        .insert({ email: normalizedEmail, full_name: normalizedName, phone_number: normalizedPhone, plan, category, topics: normalizedTopics });
      if (error) return json({ error: error.message }, 400);

      return json({ ok: true, created: true });
    }

    if (action === "import") {
      const rows = Array.isArray(body.subscribers) ? body.subscribers : [];
      const updatedAt = new Date().toISOString();
      const normalizedByEmail = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const email = row?.email?.trim()?.toLowerCase() || "";
        if (!email) continue;
        const plan = normalizePlan(row?.plan);
        const category = plan === "daily-wrap" ? null : normalizePlanCategory(row?.category);
        const topics = row?.topics ? normalizeTopics(row.topics) : topicsForPlan(plan, category);
        normalizedByEmail.set(email, {
          email,
          full_name: row?.full_name?.trim() || null,
          phone_number: row?.phone_number?.trim() || null,
          plan,
          category,
          topics,
          status: "subscribed",
          updated_at: updatedAt
        });
      }
      const normalizedRows = Array.from(normalizedByEmail.values());

      if (normalizedRows.length === 0) {
        return json({ error: "No valid subscribers found in CSV" }, 400);
      }

      const { error } = await supabase
        .from("subscribers")
        .upsert(normalizedRows, { onConflict: "email" });
      if (error) return json({ error: error.message, code: error.code, details: error.details }, 400);

      return json({ ok: true, imported: normalizedRows.length });
    }

    if (action === "update") {
      const { id, status } = body;
      if (!id) return json({ error: "id is required" }, 400);
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (status) patch.status = status;
      if ("plan" in body) {
        const plan = normalizePlan(body.plan);
        patch.plan = plan;
        const category = plan === "daily-wrap" ? null : normalizePlanCategory(body.category);
        patch.category = category;
        patch.topics = topicsForPlan(plan, category);
      } else if ("topics" in body) {
        patch.topics = normalizeTopics(body.topics);
      }
      const { error } = await supabase
        .from("subscribers")
        .update(patch)
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "delete") {
      const { id } = body;
      if (!id) return json({ error: "id is required" }, 400);
      const { error } = await supabase
        .from("subscribers")
        .delete()
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  }

  return json({ error: "Method not allowed" }, 405);
});
