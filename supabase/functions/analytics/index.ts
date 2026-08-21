import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { requireAgent } from "../_shared/agent-auth.ts";

type DigestRow = {
  id: string;
  sent_at: string;
  recipients: number | null;
  sent: number | null;
  failed: number | null;
};

type DeliveryHealthRow = {
  digest_id: string;
  accepted: number | string;
  delivered: number | string;
  bounced: number | string;
  complained: number | string;
  unconfirmed: number | string;
};

const number = (value: number | string | null | undefined) => Number(value ?? 0);
const percent = (part: number, total: number) => total > 0 ? Math.round((part / total) * 1000) / 10 : null;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const denied = await requireAgent(request);
  if (denied) return denied;

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const [activeResult, totalResult, articleResult, digestCountResult, digestResult, healthResult] = await Promise.all([
    supabase.from("subscribers").select("id", { count: "exact", head: true }).eq("status", "subscribed"),
    supabase.from("subscribers").select("id", { count: "exact", head: true }),
    supabase.from("articles").select("id", { count: "exact", head: true }).in("status", ["summarized", "approved", "rejected", "sent"]),
    supabase.from("digests").select("id", { count: "exact", head: true }),
    supabase.from("digests").select("id,sent_at,recipients,sent,failed").order("sent_at", { ascending: false }).limit(1000),
    supabase.from("delivery_health").select("digest_id,accepted,delivered,bounced,complained,unconfirmed"),
  ]);

  const error = activeResult.error || totalResult.error || articleResult.error || digestCountResult.error || digestResult.error || healthResult.error;
  if (error) return json({ error: error.message }, 500);

  const healthByDigest = new Map((healthResult.data as DeliveryHealthRow[] ?? []).map((row) => [row.digest_id, row]));
  const digests = (digestResult.data as DigestRow[] ?? []).map((digest) => {
    const health = healthByDigest.get(digest.id);
    // The per-recipient log is the source of truth whenever it exists. Older
    // digest summaries are retained only as a fallback for sends without logs.
    const trackedAccepted = number(health?.accepted);
    const accepted = trackedAccepted || number(digest.sent);
    const delivered = number(health?.delivered);
    const bounced = number(health?.bounced);
    const complained = number(health?.complained);
    const pending = health ? number(health.unconfirmed) : Math.max(accepted - delivered - bounced - complained, 0);
    return {
      id: digest.id,
      sent_at: digest.sent_at,
      recipients: number(digest.recipients),
      accepted,
      failed: number(digest.failed),
      delivered,
      bounced,
      complained,
      pending,
    };
  });

  const totals = digests.reduce((sum, digest) => ({
    accepted: sum.accepted + digest.accepted,
    failed: sum.failed + digest.failed,
    delivered: sum.delivered + digest.delivered,
    bounced: sum.bounced + digest.bounced,
    complained: sum.complained + digest.complained,
    pending: sum.pending + digest.pending,
  }), { accepted: 0, failed: 0, delivered: 0, bounced: 0, complained: 0, pending: 0 });

  // A delivery percentage is only shown after SES has reported an outcome for every accepted message.
  const deliveryRate = totals.accepted > 0 && totals.pending === 0 ? percent(totals.delivered, totals.accepted) : null;

  return json({
    stats: {
      total_digests: digestCountResult.count ?? 0,
      total_subscribers: totalResult.count ?? 0,
      active_subscribers: activeResult.count ?? 0,
      processed_articles: articleResult.count ?? 0,
      ses_accepted: totals.accepted,
      ses_failed: totals.failed,
      confirmed_delivered: totals.delivered,
      bounced: totals.bounced,
      complained: totals.complained,
      awaiting_ses_events: totals.pending,
      confirmed_delivery_rate: deliveryRate,
    },
    digests: digests.slice(0, 50),
    generated_at: new Date().toISOString(),
  });
});
