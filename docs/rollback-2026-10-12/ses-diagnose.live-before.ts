// ses-diagnose
//
// WHY THIS EXISTS
// A send can report {"sent":282,"failed":0} and still never arrive. "sent"
// only means SES ACCEPTED the API call and handed back a message id. SES then
// silently drops the message if the address is on the account suppression
// list, and there is nothing in our database that records it -- email_events
// has been empty since it was created because the bounce webhook was never
// wired up.
//
// On 2026-08-21 three named readers on the Friday list reported no intro mail
// after a clean 282/282 send. Nothing on our side could tell them apart from
// the 279 that worked, so this asks SES.
//
// Read-only. It sends nothing and changes nothing. Same requireAgent() gate as
// every other operational function, because the suppression list is a list of
// real addresses.
import { SESv2Client, GetAccountCommand, GetEmailIdentityCommand, GetSuppressedDestinationCommand, ListSuppressedDestinationsCommand } from "npm:@aws-sdk/client-sesv2";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { requireAgent } from "../_shared/agent-auth.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const denied = await requireAgent(request);
  if (denied) return denied;

  let emails: string[] = [];
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (Array.isArray(body?.emails)) {
      emails = body.emails.map((e: unknown) => String(e).trim().toLowerCase()).filter(Boolean);
    }
  }

  const client = new SESv2Client({
    region: requiredEnv("AWS_REGION"),
    credentials: {
      accessKeyId: requiredEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("AWS_SECRET_ACCESS_KEY"),
    },
  });

  const out: Record<string, unknown> = { from: Deno.env.get("FROM_EMAIL") ?? null };

  try {
    const a = await client.send(new GetAccountCommand({}));
    out.account = {
      sendingEnabled: a.SendingEnabled,
      // False here means the account is still in the SES sandbox, which only
      // delivers to verified addresses and silently limits everything else.
      productionAccess: a.ProductionAccessEnabled,
      enforcementStatus: a.EnforcementStatus,
      suppressedReasons: a.SuppressionAttributes?.SuppressedReasons ?? [],
      max24Hour: a.SendQuota?.Max24HourSend,
      sentLast24Hours: a.SendQuota?.SentLast24Hours,
      maxSendRate: a.SendQuota?.MaxSendRate,
    };
  } catch (e) {
    out.accountError = String(e).slice(0, 300);
  }

  // Per-address verdict for the ones we were asked about.
  const checked: Array<Record<string, unknown>> = [];
  for (const email of emails) {
    try {
      const r = await client.send(new GetSuppressedDestinationCommand({ EmailAddress: email }));
      checked.push({
        email,
        suppressed: true,
        reason: r.SuppressedDestination?.Reason,
        since: r.SuppressedDestination?.LastUpdateTime,
        diagnostic: (r.SuppressedDestination?.Attributes as Record<string, unknown> | undefined) ?? null,
      });
    } catch (e) {
      const name = (e as { name?: string })?.name ?? "";
      checked.push(name === "NotFoundException"
        ? { email, suppressed: false }
        : { email, suppressed: null, error: String(e).slice(0, 200) });
    }
  }
  out.checked = checked;

  // Authentication is the other way a fully-accepted send disappears. If the
  // sending domain is not DKIM-signed by SES, the recipient sees mail claiming
  // to be From: our domain arriving from an IP our SPF record does not list --
  // which Google Workspace treats as spoofing of its own domain and quarantines
  // before the inbox.
  const identities: Array<Record<string, unknown>> = [];
  for (const id of ["dailymattr.com", "team@dailymattr.com"]) {
    try {
      const r = await client.send(new GetEmailIdentityCommand({ EmailIdentity: id }));
      identities.push({
        identity: id,
        type: r.IdentityType,
        verified: r.VerifiedForSendingStatus,
        dkimStatus: r.DkimAttributes?.Status,
        dkimSigning: r.DkimAttributes?.SigningEnabled,
        dkimTokens: r.DkimAttributes?.Tokens ?? [],
        // A custom MAIL FROM is what makes SPF ALIGN with the From: domain.
        // Without it SES uses amazonses.com and SPF alignment fails, leaving
        // DKIM as the only thing that can carry DMARC.
        mailFromDomain: r.MailFromAttributes?.MailFromDomain ?? null,
        mailFromStatus: r.MailFromAttributes?.MailFromDomainStatus ?? null,
      });
    } catch (e) {
      identities.push({ identity: id, error: String((e as { name?: string })?.name ?? e).slice(0, 120) });
    }
  }
  out.identities = identities;

  // The whole list. The first version passed only PageSize and came back
  // empty while a per-address lookup found entries -- ListSuppressedDestinations
  // needs an explicit date window and NextToken paging, and silently returns
  // nothing rather than erroring without them.
  try {
    const rows: Array<{ email: string; reason: string; since: string }> = [];
    const trace: string[] = [];
    let token: string | undefined = undefined;
    // Computed ONCE. A NextToken is only valid against the exact same window,
    // and recomputing EndDate from Date.now() on every iteration moved it by a
    // few milliseconds each page -- which SES rejects as
    // InvalidNextTokenException on page two, with page one looking fine.
    const START = new Date("2020-01-01T00:00:00Z");
    const END = new Date(Date.now() + 86400000);
    for (let i = 0; i < 100; i++) {
      const params: Record<string, unknown> = {
        StartDate: START,
        EndDate: END,
        PageSize: 1000,
      };
      // Only set NextToken once we actually have one: sending the key with an
      // undefined value serialises to an empty token and SES answers
      // InvalidNextTokenException on the very first page.
      if (token) params.NextToken = token;
      const res: any = await client.send(new ListSuppressedDestinationsCommand(params as any));
      for (const d of res.SuppressedDestinations ?? []) {
        rows.push({
          email: String(d.EmailAddress).toLowerCase(),
          reason: String(d.Reason),
          since: String(d.LastUpdateTime),
        });
      }
      trace.push(`page ${i}: ${(res.SuppressedDestinations ?? []).length} rows, token=${res.NextToken ? "yes" : "no"}`);
      out.suppressionTrace = trace;   // assigned per page: a throw on page N
      out.suppressionListSize = rows.length;  // must not discard pages 0..N-1
      out.suppressed = rows;
      token = res.NextToken;
      // SES returns EMPTY pages with a continuation token, so an empty page is
      // not the end of the list -- only a missing token is.
      if (!token) break;
    }
    out.suppressionListSize = rows.length;
    out.suppressed = rows;
  } catch (e) {
    out.suppressionListError = String(e).slice(0, 300);
    // Fall back to the paging-free form. It returns at most one page, but one
    // page of real data beats an empty list while the token form is broken.
    try {
      const res: any = await client.send(new ListSuppressedDestinationsCommand({}));
      out.suppressionFallback = (res.SuppressedDestinations ?? []).map((d: any) => ({
        email: String(d.EmailAddress).toLowerCase(),
        reason: String(d.Reason),
        since: String(d.LastUpdateTime),
      }));
      out.suppressionFallbackToken = res.NextToken ? "yes" : "no";
    } catch (e2) {
      out.suppressionFallbackError = String(e2).slice(0, 300);
    }
  }


  // The suppression list is the ONLY per-address record of who bounced --
  // email_events has never received a webhook. The paged call returns empty
  // pages, so try the documented variants and report which one yields rows
  // rather than guessing.
  if ((request.headers.get("x-probe") ?? "") === "suppression") {
    const variants: Array<Record<string, unknown>> = [
      { label: "bare" },
      { label: "reasons-bounce", Reasons: ["BOUNCE"] },
      { label: "last-3-days", StartDate: new Date(Date.now() - 3 * 86400000) },
      { label: "last-3-days-bounce", StartDate: new Date(Date.now() - 3 * 86400000), Reasons: ["BOUNCE"] },
      { label: "since-2026", StartDate: new Date("2026-01-01T00:00:00Z"), EndDate: new Date() },
    ];
    const probes: Array<Record<string, unknown>> = [];
    for (const v of variants) {
      const { label, ...args } = v as { label: string };
      try {
        const res: any = await client.send(new ListSuppressedDestinationsCommand(args as any));
        const got = res.SuppressedDestinations ?? [];
        probes.push({
          label, rows: got.length, token: res.NextToken ? "yes" : "no",
          first: got.slice(0, 3).map((d: any) => `${d.EmailAddress} ${d.Reason}`),
        });
      } catch (e) {
        probes.push({ label, error: String((e as { name?: string })?.name ?? e).slice(0, 90) });
      }
    }
    out.probes = probes;
  }

  return json(out);
});
