// verify-subscribers: pre-send email verification for the subscriber list.
//
// Verifies addresses in small batches (syntax, typo/disposable domains, MX
// lookup — see _shared/email-verify.ts) and records the verdict on each
// subscriber. Provably-dead addresses get status='invalid', which removes
// them from every send automatically (all send paths filter on
// status='subscribed'). 'risky' verdicts stay subscribed — they are a
// dashboard signal, not a suppression.
//
//   GET                      -> verification summary counts
//   POST {}                  -> verify up to `limit` unverified subscribers
//   POST {limit: 200}        -> bigger slice (capped; call repeatedly to drain)
//   POST {recheck: true}     -> re-verify ALL subscribed addresses, oldest
//                               verdict first (limit still applies)
//   POST {email: "a@b.com"}  -> verify one address ad hoc (no DB writes)
//
// Each call is a bounded slice so it always fits the edge time budget; the
// dashboard (or a cron) calls it repeatedly until `remaining` is 0.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { requireAgent } from "../_shared/agent-auth.ts";
import { verifyEmailAddress } from "../_shared/email-verify.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;
// DNS lookups dominate; small concurrent groups keep total wall time bounded
// without hammering the resolver.
const GROUP = 10;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const denied = await requireAgent(request);
  if (denied) return denied;

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  if (request.method === "GET") {
    const count = async (filter: (q: any) => any) => {
      const { count: n } = await filter(
        supabase.from("subscribers").select("id", { count: "exact", head: true })
      );
      return n ?? 0;
    };
    const [unverified, valid, risky, invalid, suppressed] = await Promise.all([
      count((q: any) => q.eq("status", "subscribed").eq("verification_status", "unverified")),
      count((q: any) => q.eq("verification_status", "valid")),
      count((q: any) => q.eq("verification_status", "risky")),
      count((q: any) => q.eq("verification_status", "invalid")),
      count((q: any) => q.eq("status", "invalid")),
    ]);
    return json({ unverified, valid, risky, invalid, suppressed });
  }

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await request.json().catch(() => ({}));

  // ---- ad-hoc single-address check (no DB writes) ----
  if (body.email) {
    const result = await verifyEmailAddress(body.email);
    return json({ ok: true, ...result });
  }

  const limit = Math.min(Math.max(parseInt(String(body.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const recheck = body.recheck === true;

  let query = supabase
    .from("subscribers")
    .select("id,email")
    .eq("status", "subscribed")
    .limit(limit);
  query = recheck
    ? query.order("verified_at", { ascending: true, nullsFirst: true })
    : query.eq("verification_status", "unverified").order("created_at", { ascending: true });

  const { data: pending, error } = await query;
  if (error) return json({ error: error.message }, 500);
  const rows = pending ?? [];

  const now = new Date().toISOString();
  const tally = { checked: 0, valid: 0, risky: 0, invalid: 0 };
  const invalidSamples: Array<{ email: string; reason: string }> = [];

  for (let i = 0; i < rows.length; i += GROUP) {
    const group = rows.slice(i, i + GROUP);
    await Promise.all(group.map(async (row) => {
      const result = await verifyEmailAddress(row.email);
      tally.checked++;
      tally[result.verdict]++;
      const patch: Record<string, unknown> = {
        verification_status: result.verdict,
        verified_at: now,
        verification_reason: result.reason,
        updated_at: now,
      };
      // Only provably-dead addresses leave the audience.
      if (result.verdict === "invalid") {
        patch.status = "invalid";
        if (invalidSamples.length < 20) invalidSamples.push({ email: result.email, reason: result.reason });
      }
      await supabase.from("subscribers").update(patch).eq("id", row.id);
    }));
  }

  const { count: remaining } = await supabase
    .from("subscribers")
    .select("id", { count: "exact", head: true })
    .eq("status", "subscribed")
    .eq("verification_status", "unverified");

  return json({
    ok: true,
    ...tally,
    removed: tally.invalid,
    remaining: remaining ?? 0,
    done: (remaining ?? 0) === 0,
    invalid_samples: invalidSamples,
  });
});
