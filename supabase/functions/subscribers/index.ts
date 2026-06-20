import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";

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

function normalizeCategory(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return [...VALID_CATEGORIES].find((cat) => cat.toLowerCase() === raw.toLowerCase()) ?? null;
}

// Keep topics[] meaningful for the subscriber list + backward compatibility.
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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  if (request.method === "GET") {
    const { data, error } = await supabase
      .from("subscribers")
      .select("id,email,full_name,phone_number,topics,plan,category,status,created_at")
      .order("created_at", { ascending: false });
    if (error) return json({ error: error.message }, 500);
    return json({ subscribers: data });
  }

  if (request.method === "POST") {
    const body = await request.json();
    const { action } = body;

    if (action === "add") {
      const { email, full_name, phone_number } = body;
      if (!email?.trim()) return json({ error: "email is required" }, 400);
      const normalizedEmail = email.trim().toLowerCase();
      const normalizedName = full_name?.trim() || null;
      const normalizedPhone = phone_number?.trim() || null;

      const plan = normalizePlan(body.plan);
      const category = plan === "daily-wrap" ? null : normalizeCategory(body.category);
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
        return json({
          ok: true,
          existing: true,
          resubscribed: existing.status !== "subscribed"
        });
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
        const category = plan === "daily-wrap" ? null : normalizeCategory(row?.category);
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
        const category = plan === "daily-wrap" ? null : normalizeCategory(body.category);
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
