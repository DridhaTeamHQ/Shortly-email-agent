// The permanent "never send" list (public.email_suppressions): hard bounces,
// spam complaints, repeated soft bounces, unsubscribes, manual blocks. It is
// kept by database triggers on email_events and subscribers; every send path
// checks it here as well, so a suppressed address is skipped even if a row
// somewhere still says 'subscribed'.

// deno-lint-ignore no-explicit-any
type Client = any;

/** Which of these addresses are suppressed (lower-cased). Chunked so a long
 * list never overflows the request URL. */
export async function suppressedAmong(supabase: Client, emails: string[]): Promise<Set<string>> {
  const wanted = [...new Set(emails.map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean))];
  const found = new Set<string>();
  for (let i = 0; i < wanted.length; i += 100) {
    const { data, error } = await supabase
      .from("email_suppressions")
      .select("email")
      .in("email", wanted.slice(i, i + 100));
    // Fail closed: if the list cannot be read, nothing is cleared to send.
    if (error) throw new Error(`could not read the suppression list: ${error.message}`);
    for (const row of data ?? []) found.add(String(row.email));
  }
  return found;
}

/** Every suppressed address, paged past PostgREST's 1,000-row cap. For the
 * newsletter, which screens the whole audience at once. */
export async function allSuppressed(supabase: Client): Promise<Set<string>> {
  const found = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("email_suppressions")
      .select("email")
      .order("email")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`could not read the suppression list: ${error.message}`);
    for (const row of data ?? []) found.add(String(row.email));
    if ((data?.length ?? 0) < PAGE) return found;
  }
}

export async function isSuppressed(supabase: Client, email: string): Promise<boolean> {
  return (await suppressedAmong(supabase, [email])).size > 0;
}
