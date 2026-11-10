// Named domain mails: the non-Gmail addresses the owner adds personally.
// Union of the named_addresses table (dashboard "Domain mails" box) and the
// older ALLOWED_EMAIL_ADDRESSES secret. Mail to them goes through
// SES_NAMED_CONFIGURATION_SET (mailer.ts) and they skip the newsletter domain
// hold (send-guard.ts). Cached for a minute per function instance; a missing
// table (before migration 20261110_named_addresses) just means "secret only".
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

let cache: { at: number; set: Set<string> } | null = null;

const fromSecret = () =>
  (Deno.env.get("ALLOWED_EMAIL_ADDRESSES") ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

export async function namedAddresses(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < 60_000) return cache.set;
  const set = new Set(fromSecret());
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (url && key) {
    const { data, error } = await createClient(url, key).from("named_addresses").select("email");
    if (error) console.error(JSON.stringify({ tag: "named-addresses", error: error.message }));
    for (const r of data ?? []) set.add(String(r.email).toLowerCase());
  }
  cache = { at: Date.now(), set };
  return set;
}

/** After the dashboard adds or removes one, so this instance sees it at once. */
export function forgetNamedAddresses() {
  cache = null;
}

export const isFromSecret = (email: string) => fromSecret().includes(email.toLowerCase());
