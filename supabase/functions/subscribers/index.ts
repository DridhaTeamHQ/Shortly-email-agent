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
import { sendWelcomeEmail } from "../_shared/welcome-send.ts";
import { staticVerify, verifyDomain, verifyEmailAddress } from "../_shared/email-verify.ts";
import { checkBounceRate } from "../_shared/send-guard.ts";
import { isSuppressed, suppressedAmong, suppressionReasonsAmong } from "../_shared/suppression.ts";
import { neverSendReason, neverSendStatus, neverSendWhy } from "../_shared/never-send-status.ts";

function istToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

async function sendWelcome(email: string, name: string | null) {
  try {
    const result = await sendWelcomeEmail(email, name);
    /* One line per welcome attempt, in the function logs.
     *
     * "welcome_sent: true" on its own cannot answer "did the intro mail go
     * out?": it does not distinguish SES from the Brevo fallback, and carries
     * no message id, so a reader who never received the mail cannot be traced
     * in either provider's console. email_events is still empty (no SES event
     * destination is configured), which makes this the only per-recipient
     * record that the welcome was handed off at all. */
    console.log(JSON.stringify({
      tag: "welcome-email",
      email,
      ok: result.ok,
      provider: result.provider ?? null,
      from: result.from ?? null,
      messageId: result.messageId ?? null,
      error: result.error ?? null,
    }));
    return result.ok
      ? { sent: true, provider: result.provider ?? null, messageId: result.messageId ?? null }
      : { sent: false, provider: result.provider ?? null, error: result.error ?? "Email provider rejected the message" };
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function sendWelcomeIfNeeded(
  supabase: ReturnType<typeof createClient>,
  subscriberId: string,
  email: string,
  name: string | null,
  welcomeSentAt: string | null | undefined,
) {
  if (welcomeSentAt) {
    return { sent: false, skipped: true, provider: null, messageId: null, error: null };
  }
  // Never mail an address on the suppression list (hard bounce, complaint,
  // unsubscribed...), whichever path asked for the welcome.
  if (await isSuppressed(supabase, email)) {
    return { sent: false, skipped: true, provider: null, messageId: null, error: "on the suppression list" };
  }

  const welcome = await sendWelcome(email, name);
  if (!welcome.sent) return { ...welcome, skipped: false };

  const { error } = await supabase
    .from("subscribers")
    .update({ welcome_sent_at: new Date().toISOString() })
    .eq("id", subscriberId);
  if (error) console.error("Welcome email was sent but could not be recorded", error);
  return { ...welcome, skipped: false };
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
const COMMON_EMAIL_DOMAIN_TYPOS: Record<string, string> = {
  "gamil.com": "gmail.com",
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmail.con": "gmail.com",
  "hotmai.com": "hotmail.com",
  "yahoo.con": "yahoo.com",
  "outlook.con": "outlook.com",
};
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

function validateEmailAddress(value: unknown): { email: string; error: string | null } {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { email, error: "Enter a valid email address." };
  }
  const [local, domain] = email.split("@");
  const suggestion = COMMON_EMAIL_DOMAIN_TYPOS[domain];
  return suggestion
    ? { email, error: `Check the email domain. Did you mean ${local}@${suggestion}?` }
    : { email, error: null };
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
    // PostgREST limits a response to 1,000 rows by default. Page through the
    // list so dashboard counts and exports include the complete audience.
    const loadAllSubscribers = async () => {
      const pageSize = 1000;
      const subscribers: Record<string, unknown>[] = [];
      for (let from = 0; ; from += pageSize) {
        const result = await supabase
          .from("subscribers")
          .select("id,email,full_name,phone_number,topics,plan,category,rhythm,send_days,news_categories,source_preference,status,created_at,unsubscribed_at,verification_status,verified_at,verification_reason")
          .order("created_at", { ascending: false })
          .range(from, from + pageSize - 1);
        if (result.error) return { data: null, error: result.error };
        const page = result.data ?? [];
        subscribers.push(...page);
        if (page.length < pageSize) return { data: subscribers, error: null };
      }
    };

    const loadAllMemberships = async () => {
      const pageSize = 1000;
      const memberships: Record<string, unknown>[] = [];
      for (let from = 0; ; from += pageSize) {
        const result = await supabase
          .from("subscriber_group_members")
          .select("subscriber_id,group_id")
          .range(from, from + pageSize - 1);
        if (result.error) return { data: null, error: result.error };
        const page = result.data ?? [];
        memberships.push(...page);
        if (page.length < pageSize) return { data: memberships, error: null };
      }
    };

    const [subscriberResult, groupResult, membershipResult] = await Promise.all([
      loadAllSubscribers(),
      supabase
        .from("subscriber_groups")
        .select("id,name,created_at")
        .order("name", { ascending: true }),
      loadAllMemberships(),
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
        .select("id,email,full_name,welcome_sent_at")
        .in("email", emails);
      if (error) return json({ error: error.message }, 500);

      const known = new Map((subscribers ?? []).map((subscriber) => [subscriber.email, subscriber]));
      const suppressed = await suppressedAmong(supabase, emails as string[]);
      const results = [];
      for (const email of emails) {
        if (suppressed.has(email as string)) {
          results.push({ email, sent: false, skipped: true, error: "on the suppression list" });
          continue;
        }
        const subscriber = known.get(email);
        const welcome = subscriber
          ? await sendWelcomeIfNeeded(supabase, subscriber.id, email, subscriber.full_name ?? null, subscriber.welcome_sent_at)
          : await sendWelcome(email, null);
        results.push({ email, ...welcome });
      }
      return json({ ok: true, results });
    }

    // NEW consumer subscribe (website form): rhythm + categories[] + source pref.
    if (action === "subscribe") {
      const { email, name, full_name } = body;
      const { email: normalizedEmail, error: emailError } = validateEmailAddress(email);
      if (emailError) return json({ error: emailError }, 400);
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
        .select("id,status,full_name,welcome_sent_at")
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
        const welcome = await sendWelcomeIfNeeded(supabase, existing.id, normalizedEmail, normalizedName ?? existing.full_name, existing.welcome_sent_at);
        return json({
          ok: true,
          existing: true,
          resubscribed: existing.status !== "subscribed",
          welcome_sent: welcome.sent,
          welcome_skipped: welcome.skipped,
          welcome_provider: welcome.provider ?? null,
          welcome_message_id: welcome.messageId ?? null,
          ...(welcome.error ? { welcome_error: welcome.error } : {}),
        });
      }

      const { data: createdSubscriber, error } = await supabase
        .from("subscribers")
        .insert({ email: normalizedEmail, ...record })
        .select("id")
        .single();
      if (error) return json({ error: error.message }, 400);
      const welcome = await sendWelcomeIfNeeded(supabase, createdSubscriber.id, normalizedEmail, normalizedName, null);
      return json({
        ok: true,
        created: true,
        welcome_sent: welcome.sent,
        welcome_provider: welcome.provider ?? null,
        welcome_message_id: welcome.messageId ?? null,
        ...(welcome.error ? { welcome_error: welcome.error } : {}),
      });
    }

    if (action === "add") {
      const { email, full_name, phone_number } = body;
      const { email: normalizedEmail, error: emailError } = validateEmailAddress(email);
      if (emailError) return json({ error: emailError }, 400);
      // Full pre-send verification (disposable domain, MX lookup). Reject only
      // provably-dead addresses; 'risky' is recorded but accepted.
      const verification = await verifyEmailAddress(normalizedEmail);
      if (verification.verdict === "invalid") {
        return json({ error: `This email can't receive mail: ${verification.reason}` }, 400);
      }
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
        .select("id,status,full_name,phone_number,topics,welcome_sent_at")
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
          verification_status: verification.verdict,
          verified_at: new Date().toISOString(),
          verification_reason: verification.reason,
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
        const welcome = await sendWelcomeIfNeeded(supabase, existing.id, normalizedEmail, normalizedName ?? existing.full_name, existing.welcome_sent_at);
        return json({
          ok: true,
          existing: true,
          resubscribed: existing.status !== "subscribed",
          welcome_sent: welcome.sent,
          welcome_skipped: welcome.skipped,
          welcome_provider: welcome.provider ?? null,
          welcome_message_id: welcome.messageId ?? null,
          ...(welcome.error ? { welcome_error: welcome.error } : {}),
        });
      }

      const { data: created, error } = await supabase
        .from("subscribers")
        .insert({
          email: normalizedEmail, full_name: normalizedName, phone_number: normalizedPhone, plan, category, topics: normalizedTopics,
          verification_status: verification.verdict, verified_at: new Date().toISOString(), verification_reason: verification.reason
        })
        .select("id")
        .single();
      if (error) return json({ error: error.message }, 400);
      await setLinkedAccountSubscriptionStatus(supabase, normalizedEmail, "subscribed");
      try {
        await addSubscribersToGroup(supabase, groupId, [created.id]);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Failed to add subscriber to group." }, 400);
      }

      const welcome = await sendWelcomeIfNeeded(supabase, created.id, normalizedEmail, normalizedName, null);
      return json({
        ok: true,
        created: true,
        welcome_sent: welcome.sent,
        welcome_provider: welcome.provider ?? null,
        welcome_message_id: welcome.messageId ?? null,
        ...(welcome.error ? { welcome_error: welcome.error } : {}),
      });
    }

    // ---- Daily batch: ADD-ONLY import ------------------------------------
    // Unlike "import", this never touches an address already in the table: an
    // unsubscribed or bounced person stays that way, and someone enrolled by an
    // earlier batch keeps their dates. New addresses join today's batch
    // ("Batch <IST date>"; several uploads on one day share it) and are queued
    // for a welcome email; send-welcomes sends it and sets their newsletter
    // start to the following day.
    if (action === "import-batch") {
      const rows = Array.isArray(body.subscribers) ? body.subscribers : [];
      if (rows.length === 0) return json({ error: "No rows in this upload." }, 400);
      if (rows.length > 5000) return json({ error: "Upload at most 5,000 rows at a time." }, 400);
      const receivedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.received_on ?? "")) ? String(body.received_on) : istToday();
      const batchName = `Batch ${receivedOn}`;

      const findBatch = () => supabase
        .from("subscriber_groups")
        .select("id,name,is_daily_batch,received_on,added_count")
        .ilike("name", batchName)
        .maybeSingle();
      let { data: batch, error: batchError } = await findBatch();
      if (batchError) return json({ error: batchError.message }, 500);
      if (!batch) {
        const { error: createError } = await supabase
          .from("subscriber_groups")
          .insert({ name: batchName, is_daily_batch: true, received_on: receivedOn });
        // 23505: a parallel upload created it first -- use theirs.
        if (createError && createError.code !== "23505") return json({ error: createError.message }, 500);
        ({ data: batch, error: batchError } = await findBatch());
        if (batchError || !batch) return json({ error: batchError?.message ?? "Could not create today's batch." }, 500);
      }
      if (!batch.is_daily_batch) {
        return json({ error: `A regular group is already named "${batchName}". Rename it, then upload again.` }, 409);
      }

      // A cell may hold several addresses ("a@x.com, a@x.com"); split them.
      let invalid = 0;
      let duplicates = 0;
      const invalidSamples: Array<{ email: string; reason: string }> = [];
      const byEmail = new Map<string, string | null>();
      // Every address the pre-check rejects goes on the never-send list with
      // its status (precheck_domain / precheck_validity), so it can never be
      // re-added by a later upload.
      const rejects = new Map<string, { code: string; reason: string }>();
      const reject = (email: string, code: string | undefined, reason: string) => {
        invalid++;
        if (invalidSamples.length < 20) invalidSamples.push({ email, reason });
        if (email.includes("@") && !rejects.has(email)) rejects.set(email, { code: code ?? "precheck_validity", reason });
      };
      for (const row of rows) {
        const parts = String(row?.email ?? "").split(/[,;\s]+/).map((part) => part.trim()).filter(Boolean);
        if (parts.length === 0) { invalid++; continue; }
        for (const part of parts) {
          const { email, error: emailError } = validateEmailAddress(part);
          const staticFail = emailError ? null : staticVerify(email);
          if (emailError || staticFail) {
            reject(email, staticFail?.code, staticFail?.reason ?? emailError ?? "invalid");
            continue;
          }
          if (byEmail.has(email)) { duplicates++; continue; }
          byEmail.set(email, String(row?.full_name ?? "").trim() || null);
        }
      }

      // Anyone already in the table, in any state, is left alone. Looked up in
      // chunks: one .in() with thousands of addresses overflows the URL.
      const emails = [...byEmail.keys()];
      const known = new Set<string>();
      // Addresses in this upload that unsubscribed earlier. Never welcomed or
      // mailed again automatically: the dashboard lists them and the owner
      // ticks the ones to approve (action "resubscribe-selected").
      const unsubscribedFound: Array<{ email: string; name: string | null; unsubscribed_on: string | null; on_list: boolean }> = [];
      for (let i = 0; i < emails.length; i += 100) {
        const { data, error } = await supabase.from("subscribers").select("email,status,unsubscribed_at").in("email", emails.slice(i, i + 100));
        if (error) return json({ error: error.message }, 500);
        for (const r of data ?? []) {
          const email = String(r.email).toLowerCase();
          known.add(email);
          if (r.status === "unsubscribed") {
            unsubscribedFound.push({ email, name: byEmail.get(email) ?? null, unsubscribed_on: r.unsubscribed_at ?? null, on_list: true });
          }
        }
      }

      // The suppression list outlives deleted rows: an address that hard-
      // bounced, complained or unsubscribed is never re-added by a batch.
      let suppressedSet: Set<string>;
      try {
        suppressedSet = await suppressedAmong(supabase, emails.filter((email) => !known.has(email)));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }

      // Not on the list any more but on never-send ONLY as unsubscribed (e.g.
      // they used "Delete my data"): also offered to the owner for approval.
      // Any other reason (bounce, complaint, pre-check, SES) stays blocked.
      try {
        const reasons = await suppressionReasonsAmong(supabase, [...suppressedSet]);
        for (const [email, r] of reasons) {
          if (r.reasons.every((reason) => reason === "unsubscribed")) {
            unsubscribedFound.push({ email, name: byEmail.get(email) ?? null, unsubscribed_on: r.since, on_list: false });
          }
        }
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }

      // Verify only the new addresses (syntax, typo/disposable, Gmail rules,
      // mail server, role account, randomly-typed). Dead ones are dropped;
      // risky ones are stored but never welcomed or mailed until re-verified.
      const now = new Date().toISOString();
      const fresh = emails.filter((email) => !known.has(email) && !suppressedSet.has(email));
      const insertRows: Record<string, unknown>[] = [];
      const VERIFY_GROUP = 10;
      for (let i = 0; i < fresh.length; i += VERIFY_GROUP) {
        await Promise.all(fresh.slice(i, i + VERIFY_GROUP).map(async (email) => {
          const check = await verifyEmailAddress(email);
          // Only a clean pass is accepted; anything risky is rejected too.
          if (check.verdict !== "valid") {
            reject(email, check.code, check.reason);
            return;
          }
          insertRows.push({
            email,
            full_name: byEmail.get(email) ?? null,
            plan: "daily-wrap",
            topics: topicsForPlan("daily-wrap", null),
            status: "subscribed",
            verification_status: check.verdict,
            verified_at: now,
            verification_reason: check.reason,
            welcome_requested_at: now,
          });
        }));
      }

      // At most DAILY_BATCH_MAX new addresses per day across all of that day's
      // uploads. Anything past the limit is reported, not added, so it can go
      // into the next day's batch.
      const dailyMax = Number(Deno.env.get("DAILY_BATCH_MAX")) || 2500;
      const room = Math.max(0, dailyMax - Number(batch.added_count ?? 0));
      const overLimit = Math.max(0, insertRows.length - room);
      if (overLimit > 0) insertRows.splice(room);

      const addedIds: string[] = [];
      let raceSkipped = 0;
      for (let i = 0; i < insertRows.length; i += 500) {
        const chunk = insertRows.slice(i, i + 500);
        // ignoreDuplicates: an address added by a parallel upload in the
        // meantime is skipped, never overwritten.
        const { data, error } = await supabase
          .from("subscribers")
          .upsert(chunk, { onConflict: "email", ignoreDuplicates: true })
          .select("id");
        if (error) return json({ error: error.message }, 500);
        addedIds.push(...(data ?? []).map((r) => String(r.id)));
        raceSkipped += chunk.length - (data?.length ?? 0);
      }
      try {
        for (let i = 0; i < addedIds.length; i += 500) {
          await addSubscribersToGroup(supabase, batch.id, addedIds.slice(i, i + 500));
        }
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Could not add the new addresses to the batch." }, 500);
      }

      let rejectedToNeverSend = 0;
      const rejectRows = [...rejects.entries()].map(([email, r]) => ({
        email, reason: r.code, detail: r.reason, source: `import-batch ${receivedOn}`,
      }));
      for (let i = 0; i < rejectRows.length; i += 500) {
        const { data, error } = await supabase
          .from("email_suppressions")
          .upsert(rejectRows.slice(i, i + 500), { onConflict: "email,reason", ignoreDuplicates: true })
          .select("email");
        if (error) console.error("could not record pre-check rejects", error);
        rejectedToNeverSend += data?.length ?? 0;
      }

      const { error: bumpError } = await supabase.rpc("bump_batch_counts", {
        p_batch_id: batch.id,
        p_rows: rows.length,
        p_added: addedIds.length,
        p_duplicates: duplicates,
        p_invalid: invalid,
        p_already_known: known.size + raceSkipped,
        p_suppressed: suppressedSet.size,
      });
      if (bumpError) console.error("bump_batch_counts failed", bumpError);

      const heldRisky = insertRows.filter((r) => r.verification_status !== "valid").length;
      return json({
        ok: true,
        batch: { id: batch.id, name: batchName, received_on: receivedOn },
        rows: rows.length,
        added: addedIds.length,
        welcome_queued: addedIds.length - heldRisky,
        held_risky: heldRisky,
        already_known: known.size + raceSkipped,
        suppressed: suppressedSet.size,
        rejected_to_never_send: rejectedToNeverSend,
        rejected_not_gmail: [...rejects.values()].filter((r) => r.code === "precheck_domain").length,
        over_daily_limit: overLimit,
        daily_limit: dailyMax,
        duplicates_in_upload: duplicates,
        invalid,
        invalid_samples: invalidSamples,
        unsubscribed_found: unsubscribedFound,
      });
    }

    // ---- Owner-approved return of unsubscribed addresses ------------------
    // The upload lists addresses that unsubscribed earlier; only the ones the
    // owner ticks come here. They get the newsletter again from the next
    // morning, with NO new welcome. Only addresses blocked purely because they
    // unsubscribed qualify -- bounces, complaints, pre-check and SES blocks
    // can never be approved this way.
    if (action === "resubscribe-selected") {
      const picked = [...new Set((Array.isArray(body.emails) ? body.emails : [])
        .map((e: unknown) => String(e ?? "").trim().toLowerCase())
        .filter((e: string) => e.includes("@")))] as string[];
      if (picked.length === 0) return json({ error: "No addresses selected." }, 400);
      if (picked.length > 2000) return json({ error: "Select at most 2,000 addresses at a time." }, 400);

      const rowsByEmail = new Map<string, { id: string; status: string }>();
      for (let i = 0; i < picked.length; i += 100) {
        const { data, error } = await supabase.from("subscribers")
          .select("id,email,status").in("email", picked.slice(i, i + 100));
        if (error) return json({ error: error.message }, 500);
        for (const r of data ?? []) rowsByEmail.set(String(r.email).toLowerCase(), { id: String(r.id), status: String(r.status) });
      }
      let reasons: Map<string, { reasons: string[]; since: string }>;
      try {
        reasons = await suppressionReasonsAmong(supabase, picked);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }

      const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" })
        .format(new Date(Date.now() + 86400000));
      const nowIso = new Date().toISOString();
      const results: Array<{ email: string; ok: boolean; result: string }> = [];
      for (const email of picked) {
        const hard = (reasons.get(email)?.reasons ?? []).filter((r) => r !== "unsubscribed");
        if (hard.length) {
          results.push({ email, ok: false, result: `blocked: ${hard.map((r) => neverSendStatus(r)).join(", ")}` });
          continue;
        }
        // Same pre-check as an upload (gmail-only unless the owner allowed the address).
        const precheck = staticVerify(email);
        if (precheck) { results.push({ email, ok: false, result: `blocked: ${precheck.reason}` }); continue; }
        const row = rowsByEmail.get(email);
        if (row && row.status === "subscribed") { results.push({ email, ok: true, result: "already subscribed" }); continue; }
        if (row && row.status !== "unsubscribed") { results.push({ email, ok: false, result: `not unsubscribed (status ${row.status})` }); continue; }
        if (!row && !reasons.has(email)) { results.push({ email, ok: false, result: "not an unsubscribed address" }); continue; }

        if (row) {
          // The status change also clears the 'unsubscribed' never-send entry (DB trigger).
          const { error } = await supabase.from("subscribers")
            .update({ status: "subscribed", unsubscribed_at: null, newsletter_from: tomorrow, updated_at: nowIso })
            .eq("id", row.id);
          if (error) { results.push({ email, ok: false, result: error.message }); continue; }
        } else {
          // Record deleted earlier ("Delete my data"): add it back. No welcome
          // is queued (welcome_requested_at stays empty).
          const { error } = await supabase.from("subscribers").insert({
            email, plan: "daily-wrap", topics: topicsForPlan("daily-wrap", null), status: "subscribed",
            verification_status: "valid", verified_at: nowIso,
            verification_reason: `Approved again by the owner on ${istToday()} after unsubscribing`,
            newsletter_from: tomorrow,
          });
          if (error) { results.push({ email, ok: false, result: error.message }); continue; }
          await supabase.from("email_suppressions").delete().eq("email", email).eq("reason", "unsubscribed");
        }
        results.push({ email, ok: true, result: `back on the newsletter from ${tomorrow} (no new welcome)` });
      }
      return json({
        ok: true,
        approved: results.filter((r) => r.ok && r.result !== "already subscribed").length,
        refused: results.filter((r) => !r.ok).length,
        results,
      });
    }

    // Never-send list for download: who will never be mailed, and why. Dates
    // are IST calendar days; omit both for the whole list.
    if (action === "never-send-export") {
      const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ""));
      const istStart = (d: string) => new Date(`${d}T00:00:00+05:30`).toISOString();
      const rows: Array<Record<string, unknown>> = [];
      for (let from = 0; ; from += 1000) {
        let query = supabase
          .from("email_suppressions")
          .select("email,reason,detail,source,created_at")
          .order("created_at", { ascending: false })
          .range(from, from + 999);
        if (isDate(body.from)) query = query.gte("created_at", istStart(String(body.from)));
        if (isDate(body.to)) {
          const next = new Date(new Date(`${body.to}T00:00:00+05:30`).getTime() + 86400000).toISOString();
          query = query.lt("created_at", next);
        }
        const { data, error } = await query;
        if (error) return json({ error: error.message }, 500);
        rows.push(...(data ?? []).map((r) => {
          const reason = neverSendReason(r as { reason: string; detail: string | null });
          return { ...r, reason, status: neverSendStatus(reason), why: neverSendWhy(reason) };
        }));
        if ((data?.length ?? 0) < 1000) break;
      }
      return json({ rows, count: rows.length });
    }

    if (action === "batch-status") {
      const { data, error } = await supabase
        .from("daily_batch_status")
        .select("*")
        .order("received_on", { ascending: false })
        .limit(60);
      if (error) return json({ error: error.message }, 500);
      const brake = await checkBounceRate(supabase);
      return json({
        batches: data ?? [],
        sending: {
          ok: brake.ok,
          reason: brake.reason ?? null,
          hard_bounce_rate_pct: brake.rate,
          complaint_rate_pct: brake.complaintRate ?? null,
          delivered_7d: brake.delivered,
          hard_bounced_7d: brake.bounced,
          complained_7d: brake.complained,
          blocked_by_ses_7d: brake.blockedBySes ?? 0,
        },
      });
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
      let validRows = 0;
      let invalidEmailRows = 0;
      const invalidSamples: Array<{ email: string; reason: string }> = [];
      for (const row of rows) {
        const { email, error: emailError } = validateEmailAddress(row?.email);
        // Static verification on top of the shape check: typo'd, disposable,
        // and malformed addresses never enter the audience.
        const staticFail = emailError ? null : staticVerify(email);
        if (emailError || staticFail) {
          invalidEmailRows++;
          if (staticFail && invalidSamples.length < 20) invalidSamples.push({ email, reason: staticFail.reason });
          continue;
        }
        validRows++;
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

      // Domain-level DNS check on the unique domains in the file (one lookup
      // per domain, cached). Rows on dead domains are dropped and reported;
      // everything else gets its verification verdict stamped so the batch
      // verifier doesn't have to redo it.
      const domains = [...new Set([...normalizedByEmail.keys()].map((e) => e.split("@")[1]))];
      const domainVerdicts = new Map<string, { verdict: string; reason: string }>();
      const DOMAIN_GROUP = 10;
      for (let i = 0; i < domains.length; i += DOMAIN_GROUP) {
        await Promise.all(domains.slice(i, i + DOMAIN_GROUP).map(async (d) => {
          domainVerdicts.set(d, await verifyDomain(d));
        }));
      }
      for (const [email, record] of [...normalizedByEmail.entries()]) {
        const check = domainVerdicts.get(email.split("@")[1]);
        if (!check) continue;
        if (check.verdict === "invalid") {
          normalizedByEmail.delete(email);
          invalidEmailRows++;
          validRows--;
          if (invalidSamples.length < 20) invalidSamples.push({ email, reason: check.reason });
          continue;
        }
        record.verification_status = check.verdict;
        record.verified_at = updatedAt;
        record.verification_reason = check.reason;
      }
      // Never re-activate an address that opted out, bounced, complained or
      // is otherwise on the suppression list: this import upserts, and an
      // upsert would set them back to 'subscribed'. Looked up in chunks so a
      // large file does not overflow the request URL.
      const candidateEmails = [...normalizedByEmail.keys()];
      const existingStatus = new Map<string, string>();
      for (let i = 0; i < candidateEmails.length; i += 100) {
        const { data, error: lookupError } = await supabase
          .from("subscribers")
          .select("email,status")
          .in("email", candidateEmails.slice(i, i + 100));
        if (lookupError) return json({ error: lookupError.message }, 500);
        for (const r of data ?? []) existingStatus.set(String(r.email).toLowerCase(), String(r.status));
      }
      let suppressedSet: Set<string>;
      try {
        suppressedSet = await suppressedAmong(supabase, candidateEmails);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
      let skippedOptedOut = 0;
      for (const email of candidateEmails) {
        const status = existingStatus.get(email);
        if (suppressedSet.has(email) || (status && status !== "subscribed")) {
          normalizedByEmail.delete(email);
          skippedOptedOut++;
        }
      }
      const normalizedRows = Array.from(normalizedByEmail.values());

      if (normalizedRows.length === 0) {
        return json({
          error: skippedOptedOut
            ? `Nothing to import: ${skippedOptedOut} address(es) are unsubscribed, bounced or on the suppression list.`
            : "No valid subscribers found in CSV",
        }, 400);
      }

      const importedEmails = normalizedRows.map((row) => String(row.email));
      const existingCount = importedEmails.filter((email) => existingStatus.has(email)).length;

      const { error } = await supabase
        .from("subscribers")
        .upsert(normalizedRows, { onConflict: "email" });
      if (error) return json({ error: error.message, code: error.code, details: error.details }, 400);

      if (groupId) {
        const importedIds: string[] = [];
        for (let i = 0; i < importedEmails.length; i += 100) {
          const { data, error: lookupError } = await supabase
            .from("subscribers")
            .select("id")
            .in("email", importedEmails.slice(i, i + 100));
          if (lookupError) return json({ error: lookupError.message }, 500);
          importedIds.push(...(data ?? []).map((subscriber) => String(subscriber.id)));
        }
        try {
          await addSubscribersToGroup(supabase, groupId, importedIds);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "Failed to add imported subscribers to group." }, 400);
        }
      }

      return json({
        ok: true,
        imported: normalizedRows.length,
        created: normalizedRows.length - existingCount,
        updated: existingCount,
        duplicates_in_file: validRows - normalizedRows.length - skippedOptedOut,
        skipped_opted_out: skippedOptedOut,
        invalid_email_rows: invalidEmailRows,
        invalid_samples: invalidSamples,
      });
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

