import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import {
  normalizeCategory as normalizeNewsCategory,
  CATEGORY_SLUGS,
  VALID_DELIVERY_RHYTHMS,
  VALID_SOURCE_PREFERENCES,
  WEEKDAYS,
} from "../_shared/news-categories.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { sendEmail } from "../_shared/mailer.ts";
import { renderWelcomeEmail } from "../_shared/welcome-email.ts";

async function sendWelcome(email: string, name: string | null) {
  try {
    const result = await sendEmail({
      to: email,
      subject: "Welcome to Dailymattr",
      html: await renderWelcomeEmail(email, name),
    });
    return result.ok ? { sent: true } : { sent: false, error: result.error ?? "Email provider rejected the message" };
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Website accounts are sent from newsletter_subscriptions, while the email
// agent manages the mirrored subscribers row. Keep both stores aligned when
// an agent re-subscribes or unsubscribes a reader.
async function setLinkedAccountSubscriptionStatus(
  supabase: ReturnType<typeof createClient>,
  email: string,
  status: "subscribed" | "unsubscribed",
) {
  const { data: profiles, error: profileError } = await supabase
    .from("profiles")
    .select("id")
    .ilike("email", email.trim().toLowerCase());
  if (profileError) throw new Error(profileError.message);

  const accountIds = (profiles ?? []).map((profile) => profile.id as string);
  if (accountIds.length === 0) return;

  const { error } = await supabase
    .from("newsletter_subscriptions")
    .update({ status: status === "subscribed" ? "active" : "unsubscribed" })
    .in("user_id", accountIds);
  if (error) throw new Error(error.message);
}

function normalizeGroupIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id ?? "").trim()).filter(Boolean))];
}

async function replaceSubscriberGroups(
  supabase: ReturnType<typeof createClient>,
  subscriberId: string,
  groupIds: string[],
) {
  const { error: removeError } = await supabase
    .from("subscriber_group_members")
    .delete()
    .eq("subscriber_id", subscriberId);
  if (removeError) throw new Error(removeError.message);

  if (groupIds.length === 0) return;
  const { error: addError } = await supabase
    .from("subscriber_group_members")
    .insert(groupIds.map((groupId) => ({ subscriber_id: subscriberId, group_id: groupId })));
  if (addError) throw new Error(addError.message);
}

async function addSubscribersToGroup(
  supabase: ReturnType<typeof createClient>,
  groupId: string,
  subscriberIds: string[],
) {
  if (!groupId || subscriberIds.length === 0) return;
  await validateSubscriberGroup(supabase, groupId);

  const { error } = await supabase
    .from("subscriber_group_members")
    .upsert(
      subscriberIds.map((subscriberId) => ({ subscriber_id: subscriberId, group_id: groupId })),
      { onConflict: "subscriber_id,group_id", ignoreDuplicates: true },
    );
  if (error) throw new Error(error.message);
}

async function validateSubscriberGroup(
  supabase: ReturnType<typeof createClient>,
  groupId: string,
) {
  if (!groupId) return;
  const { data: group, error: groupError } = await supabase
    .from("subscriber_groups")
    .select("id")
    .eq("id", groupId)
    .maybeSingle();
  if (groupError) throw new Error(groupError.message);
  if (!group) throw new Error("The selected group no longer exists.");
}

// ---------- legacy plan model (kept for the old QA dashboard form) ----------
const VALID_TOPICS = new Set([
  "daily-wrap",
  "real-estate",
  "automobile",
  "health-wellness",
  "tech-ai",
  "markets-startups"
]);

const VALID_PLANS = new Set(["daily-wrap", "category-case", "wrap-category", "case-only"]);
const VALID_CATEGORIES = new Set(["Real Estate", "Automobile", "Health & Wellness", "Tech & AI", "Markets & Startups"]);
const CATEGORY_TO_SLUG: Record<string, string> = {
  "Real Estate": "real-estate",
  "Automobile": "automobile",
  "Health & Wellness": "health-wellness",
  "Tech & AI": "tech-ai",
  "Markets & Startups": "markets-startups"
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
      if (["daily", "daily-wrap", "shortly", "shortly-daily-wrap", "general"].includes(item)) return "daily-wrap";
      if (["real-estate", "realestate", "property"].includes(item)) return "real-estate";
      if (["automobile", "auto", "cars", "automotive"].includes(item)) return "automobile";
      if (["health-wellness", "wellness", "wellness-daily", "health"].includes(item)) return "health-wellness";
      if (["tech-ai", "tech", "technology", "ai"].includes(item)) return "tech-ai";
      if (["markets-startups", "money", "money-matters", "finance", "markets", "startups"].includes(item)) return "markets-startups";
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
  "real-estate": "real-estate", "realestate": "real-estate",
  "automobile": "automobile", "auto": "automobile",
  "health-wellness": "health-wellness", "wellness": "health-wellness", "wellness-daily": "health-wellness",
  "tech-ai": "tech-ai", "tech": "tech-ai", "technology": "tech-ai",
  "markets-startups": "markets-startups", "money": "markets-startups", "money-matters": "markets-startups",
};
const TOPIC_TO_CATEGORY: Record<string, string> = {
  "real-estate": "Real Estate", "automobile": "Automobile",
  "health-wellness": "Health & Wellness", "tech-ai": "Tech & AI", "markets-startups": "Markets & Startups",
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
  const cats = topics.filter((t) => t !== "daily-wrap");
  const hasWrap = topics.includes("daily-wrap");
  // Topic + wrap -> wrap + shorts; topic only -> its shorts + case study.
  let plan = "daily-wrap";
  if (cats.length && hasWrap) plan = "wrap-category";
  else if (cats.length) plan = "category-case";
  const category = cats.length ? TOPIC_TO_CATEGORY[cats[0]] : null;
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

  // The public site may ONLY submit the subscribe form. Everything else —
  // listing subscribers (PII) and admin mutations — needs the dashboard's
  // agent token or a service_role JWT.
  if (request.method !== "POST" || (await request.clone().json().catch(() => ({})))?.action !== "subscribe") {
    const denied = await requireAgent(request);
    if (denied) return denied;
  }

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  if (request.method === "GET") {
    const [subscriberResult, groupResult, membershipResult] = await Promise.all([
      supabase
        .from("subscribers")
        .select("id,email,full_name,phone_number,topics,plan,category,rhythm,send_days,news_categories,source_preference,status,created_at")
        .order("created_at", { ascending: false }),
      supabase
        .from("subscriber_groups")
        .select("id,name,created_at")
        .order("name", { ascending: true }),
      supabase
        .from("subscriber_group_members")
        .select("subscriber_id,group_id"),
    ]);
    const error = subscriberResult.error || groupResult.error || membershipResult.error;
    if (error) return json({ error: error.message }, 500);
    return json({
      subscribers: subscriberResult.data,
      groups: groupResult.data,
      memberships: membershipResult.data,
    });
  }

  if (request.method === "POST") {
    const body = await request.json();
    const { action } = body;

    if (action === "create-group") {
      const name = String(body.name ?? "").trim().replace(/\s+/g, " ");
      if (!name || name.length > 80) return json({ error: "Group names must be between 1 and 80 characters." }, 400);
      const { data, error } = await supabase
        .from("subscriber_groups")
        .insert({ name })
        .select("id,name,created_at")
        .single();
      if (error) return json({ error: error.code === "23505" ? "A group with that name already exists." : error.message }, 400);
      return json({ ok: true, group: data });
    }

    if (action === "set-subscriber-groups") {
      const subscriberId = String(body.subscriber_id ?? "").trim();
      if (!subscriberId) return json({ error: "subscriber_id is required" }, 400);
      const groupIds = normalizeGroupIds(body.group_ids);
      if (groupIds.length > 0) {
        const { data: validGroups, error } = await supabase
          .from("subscriber_groups")
          .select("id")
          .in("id", groupIds);
        if (error) return json({ error: error.message }, 500);
        if ((validGroups ?? []).length !== groupIds.length) return json({ error: "One or more selected groups no longer exist." }, 400);
      }
      try {
        await replaceSubscriberGroups(supabase, subscriberId, groupIds);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Failed to update subscriber groups." }, 500);
      }
      return json({ ok: true });
    }

    if (action === "send-welcome") {
      const emails = Array.isArray(body.emails)
        ? [...new Set(body.emails.map((email: unknown) => String(email).trim().toLowerCase()).filter((email: string) => email.includes("@")))]
        : [];
      if (emails.length === 0 || emails.length > 10) {
        return json({ error: "Provide between 1 and 10 valid email addresses." }, 400);
      }

      const { data: subscribers, error } = await supabase
        .from("subscribers")
        .select("email,full_name")
        .in("email", emails);
      if (error) return json({ error: error.message }, 500);

      const known = new Map((subscribers ?? []).map((subscriber) => [subscriber.email, subscriber.full_name ?? null]));
      const results = [];
      for (const email of emails) {
        const welcome = await sendWelcome(email, known.get(email) ?? null);
        results.push({ email, ...welcome });
      }
      return json({ ok: true, results });
    }

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
        unsubscribed_at: null,
        updated_at: new Date().toISOString(),
      };
      if (normalizedName) record.full_name = normalizedName;

      if (existing?.id) {
        if (existing.status !== "subscribed") {
          try {
            await setLinkedAccountSubscriptionStatus(supabase, normalizedEmail, "subscribed");
          } catch (error) {
            return json({ error: error instanceof Error ? error.message : "Failed to update account subscription." }, 500);
          }
        }
        const { error } = await supabase.from("subscribers").update(record).eq("id", existing.id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, existing: true, resubscribed: existing.status !== "subscribed" });
      }

      const { error } = await supabase
        .from("subscribers")
        .insert({ email: normalizedEmail, ...record });
      if (error) return json({ error: error.message }, 400);
      const welcome = await sendWelcome(normalizedEmail, normalizedName);
      return json({ ok: true, created: true, welcome_sent: welcome.sent, ...(welcome.error ? { welcome_error: welcome.error } : {}) });
    }

    if (action === "add") {
      const { email, full_name, phone_number } = body;
      if (!email?.trim() || !String(email).includes("@")) return json({ error: "A valid email is required." }, 400);
      const normalizedEmail = email.trim().toLowerCase();
      const normalizedName = full_name?.trim() || null;
      const normalizedPhone = phone_number?.trim() || null;
      const groupId = String(body.group_id ?? "").trim();

      try {
        await validateSubscriberGroup(supabase, groupId);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "The selected group is unavailable." }, 400);
      }

      const plan = normalizePlan(body.plan);
      const category = plan === "daily-wrap" ? null : normalizePlanCategory(body.category);
      if (plan !== "daily-wrap" && !category) {
        return json({ error: "Please choose a category for this plan." }, 400);
      }
      // The dashboard topic picker sends `topics`; keep plan-based requests
      // backward compatible for older callers that do not provide it.
      const normalizedTopics = "topics" in body
        ? normalizeTopics(body.topics)
        : topicsForPlan(plan, category);

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
          unsubscribed_at: null,
          updated_at: new Date().toISOString()
        };
        if (normalizedName) patch.full_name = normalizedName;
        if (normalizedPhone) patch.phone_number = normalizedPhone;
        if (existing.status !== "subscribed") {
          try {
            await setLinkedAccountSubscriptionStatus(supabase, normalizedEmail, "subscribed");
          } catch (error) {
            return json({ error: error instanceof Error ? error.message : "Failed to update account subscription." }, 500);
          }
        }
        const { error } = await supabase
          .from("subscribers")
          .update(patch)
          .eq("id", existing.id);
        if (error) return json({ error: error.message }, 400);
        try {
          await addSubscribersToGroup(supabase, groupId, [existing.id]);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "Failed to add subscriber to group." }, 400);
        }
        return json({ ok: true, existing: true, resubscribed: existing.status !== "subscribed" });
      }

      const { data: created, error } = await supabase
        .from("subscribers")
        .insert({ email: normalizedEmail, full_name: normalizedName, phone_number: normalizedPhone, plan, category, topics: normalizedTopics })
        .select("id")
        .single();
      if (error) return json({ error: error.message }, 400);
      await setLinkedAccountSubscriptionStatus(supabase, normalizedEmail, "subscribed");
      try {
        await addSubscribersToGroup(supabase, groupId, [created.id]);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Failed to add subscriber to group." }, 400);
      }

      const welcome = await sendWelcome(normalizedEmail, normalizedName);
      return json({ ok: true, created: true, welcome_sent: welcome.sent, ...(welcome.error ? { welcome_error: welcome.error } : {}) });
    }

    if (action === "import") {
      const rows = Array.isArray(body.subscribers) ? body.subscribers : [];
      const groupId = String(body.group_id ?? "").trim();
      try {
        await validateSubscriberGroup(supabase, groupId);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "The selected group is unavailable." }, 400);
      }
      const updatedAt = new Date().toISOString();
      const normalizedByEmail = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const email = row?.email?.trim()?.toLowerCase() || "";
        if (!email || !email.includes("@")) continue;
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
          unsubscribed_at: null,
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

      if (groupId) {
        const { data: importedSubscribers, error: lookupError } = await supabase
          .from("subscribers")
          .select("id")
          .in("email", normalizedRows.map((row) => String(row.email)));
        if (lookupError) return json({ error: lookupError.message }, 500);
        try {
          await addSubscribersToGroup(supabase, groupId, (importedSubscribers ?? []).map((subscriber) => subscriber.id));
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "Failed to add imported subscribers to group." }, 400);
        }
      }

      return json({ ok: true, imported: normalizedRows.length });
    }

    if (action === "update") {
      const { id, status } = body;
      if (!id) return json({ error: "id is required" }, 400);
      const { data: subscriber, error: subscriberError } = await supabase
        .from("subscribers")
        .select("id,email")
        .eq("id", id)
        .maybeSingle();
      if (subscriberError) return json({ error: subscriberError.message }, 500);
      if (!subscriber) return json({ error: "Subscriber not found." }, 404);

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (status) {
        if (status !== "subscribed" && status !== "unsubscribed") {
          return json({ error: "Unsupported subscriber status." }, 400);
        }
        try {
          await setLinkedAccountSubscriptionStatus(supabase, subscriber.email, status);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "Failed to update account subscription." }, 500);
        }
        patch.status = status;
        patch.unsubscribed_at = status === "unsubscribed" || status === "bounced"
          ? new Date().toISOString()
          : null;
      }
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

