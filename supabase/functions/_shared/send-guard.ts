// _shared/send-guard.ts
// Pre-send protection for the SES sending reputation.
//
// WHY THIS EXISTS: the previous SES account was suspended at a 15.51% bounce
// rate (AWS reviews at 5%, suspends at 10%). It built up invisibly because no
// bounce feedback was ever recorded -- 21,572 sends produced 0 delivery
// events, 0 bounce events, and 0 suppressed addresses, while every send
// reported 100% success. Nothing in the send path could tell "SES accepted it"
// from "it reached a human".
//
// Three independent brakes, each of which can stop a send on its own:
//
//   1. VERIFIED-ONLY GATE  -- only addresses that passed verification are
//      emailed. Default ON. If the list has not been verified yet, a send
//      reaches nobody rather than risking the account. That is the intended
//      failure mode: silence is recoverable, a second suspension is not.
//
//   2. DOMAIN HOLD         -- named domains are excluded regardless of their
//      verification verdict. Verification proves a DOMAIN accepts mail (it has
//      MX records); it cannot prove an individual MAILBOX exists. A domain
//      carrying hundreds of addresses can pass verification and still bounce
//      every one of them, so a suspect segment stays held until a small test
//      batch proves it.
//
//   3. BOUNCE CIRCUIT BREAKER -- refuses to start when the recently observed
//      bounce rate is at or above the abort threshold, OR when mail has
//      recently been sent and NO feedback came back at all (which is the exact
//      signature of the broken feedback loop that hid the 15.51%).
//
//      Note the asymmetry: "no events AND no recent sends" is a cold start,
//      not a fault, so it is allowed. Blocking it instead would deadlock --
//      events only exist once mail flows, so requiring events before the first
//      send makes the first send impossible.
//
// All limits are env-tunable so warm-up can be widened without a redeploy:
//   SEND_REQUIRE_VERIFIED   "0" disables the verified-only gate (default on)
//   SEND_HOLD_DOMAINS       comma-separated domains to exclude, e.g. "a.com,b.com"
//   SEND_MAX_PER_RUN        cap recipients per invocation ("0"/unset = no cap)
//   SEND_BOUNCE_ABORT_PCT   abort at/above this bounce % (default 5)
//   SEND_BOUNCE_WINDOW_DAYS lookback for the bounce rate (default 7)
//   SEND_ALLOW_BLIND        "1" permits sending with no bounce data recorded

export type Recipient = {
  email: string;
  verification_status?: string | null;
};

export type ScreenCounts = {
  considered: number;
  sending: number;
  held_unverified: number;
  held_invalid: number;
  held_domain: number;
  held_over_cap: number;
};

const flag = (name: string, fallback: string) => (Deno.env.get(name) ?? fallback).trim();
const num = (name: string, fallback: number) => {
  const parsed = Number(flag(name, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
};

function holdDomains(): Set<string> {
  return new Set(
    flag("SEND_HOLD_DOMAINS", "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Apply the verified-only gate, the domain hold, and the per-run cap.
 * Pure and synchronous: callers can log the counts before committing to a send.
 */
export function screenRecipients<T extends Recipient>(rows: T[]): { send: T[]; counts: ScreenCounts } {
  const requireVerified = flag("SEND_REQUIRE_VERIFIED", "1") !== "0";
  const held = holdDomains();
  const cap = num("SEND_MAX_PER_RUN", 0);

  const counts: ScreenCounts = {
    considered: rows.length,
    sending: 0,
    held_unverified: 0,
    held_invalid: 0,
    held_domain: 0,
    held_over_cap: 0,
  };

  const eligible: T[] = [];
  for (const row of rows) {
    const verdict = String(row.verification_status ?? "unverified");
    // A verified-invalid address is never emailed, gate on or off: it is known
    // to be undeliverable and every attempt is a bounce charged to the domain.
    if (verdict === "invalid") {
      counts.held_invalid++;
      continue;
    }
    if (requireVerified && verdict !== "valid") {
      counts.held_unverified++;
      continue;
    }
    const domain = String(row.email ?? "").trim().toLowerCase().split("@")[1] ?? "";
    if (held.has(domain)) {
      counts.held_domain++;
      continue;
    }
    eligible.push(row);
  }

  const send = cap > 0 ? eligible.slice(0, cap) : eligible;
  counts.held_over_cap = eligible.length - send.length;
  counts.sending = send.length;
  return { send, counts };
}

export type BounceCheck = {
  ok: boolean;
  rate: number | null;      // percent, null when nothing has been measured
  delivered: number;
  bounced: number;
  complained: number;
  blind: boolean;           // true when no SES events have ever been recorded
  reason?: string;
};

/**
 * Read the recently observed bounce rate from the SES event log.
 *
 * `blind: true` means the feedback loop is not delivering events, which is the
 * condition that hid the previous 15.51% bounce rate. Treated as unsafe unless
 * SEND_ALLOW_BLIND=1.
 */
// Typed as `any` to match the rest of the shared helpers: the Postgrest builder
// is a thenable chain, not a Promise, and pinning its generics here only
// couples this guard to a supabase-js version.
// deno-lint-ignore no-explicit-any
export async function checkBounceRate(supabase: any): Promise<BounceCheck> {
  const abortPct = num("SEND_BOUNCE_ABORT_PCT", 5);
  const windowDays = num("SEND_BOUNCE_WINDOW_DAYS", 7);
  const allowBlind = flag("SEND_ALLOW_BLIND", "0") === "1";
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const countOf = async (eventType: string): Promise<number> => {
    const { count } = await supabase
      .from("email_events")
      .select("id", { count: "exact", head: true })
      .gte("received_at", since)
      .eq("event_type", eventType);
    return count ?? 0;
  };

  let delivered = 0;
  let bounced = 0;
  let complained = 0;
  let recentSends = 0;
  try {
    const { count: sendCount } = await supabase
      .from("article_deliveries")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since);
    recentSends = sendCount ?? 0;
    [delivered, bounced, complained] = await Promise.all([
      countOf("delivery"),
      countOf("bounce"),
      countOf("complaint"),
    ]);
  } catch (error) {
    // Never let a telemetry read failure become a silent green light.
    return {
      ok: allowBlind,
      rate: null,
      delivered: 0,
      bounced: 0,
      complained: 0,
      blind: true,
      reason: `could not read send telemetry: ${String(error).slice(0, 160)}`,
    };
  }

  const total = delivered + bounced;
  if (total === 0) {
    // Cold start (nothing sent recently) is fine -- allow it, or the first send
    // after wiring could never run. Sent-but-silent is the dangerous case.
    const blindThreshold = num("SEND_BLIND_MIN_SENDS", 50);
    const sentButSilent = recentSends >= blindThreshold;
    return {
      ok: allowBlind || !sentButSilent,
      rate: null,
      delivered,
      bounced,
      complained,
      blind: true,
      reason: sentButSilent && !allowBlind
        ? `${recentSends} messages were sent in the last ${windowDays} days and NOT ONE ` +
          `delivery or bounce event came back. That is the broken-feedback signature that let a ` +
          `15.51% bounce rate build up unseen. Wire the SES event destination to the email-events ` +
          `function (see ses-setup-events), or set SEND_ALLOW_BLIND=1 to override deliberately.`
        : `no SES events recorded yet, and only ${recentSends} recent sends -- treating as a cold ` +
          `start. Watch email_events after this run; if it stays empty, the feedback loop is broken.`,
    };
  }

  const rate = (bounced / total) * 100;
  return {
    ok: rate < abortPct,
    rate: Number(rate.toFixed(2)),
    delivered,
    bounced,
    complained,
    blind: false,
    reason: rate < abortPct
      ? undefined
      : `bounce rate ${rate.toFixed(2)}% is at or above the ${abortPct}% abort threshold ` +
        `(AWS suspends around 10%). Clean the list before sending again.`,
  };
}
