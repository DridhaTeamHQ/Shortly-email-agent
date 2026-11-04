// _shared/page.ts
//
// PostgREST caps every response at the project's `max_rows` -- 1000 on this
// project. A bare .select() therefore returns the FIRST 1000 rows and reports
// no error, so the caller cannot tell a complete answer from a truncated one.
//
// Measured on 2026-08-21: subscriber_group_members held 1,284 rows, so the
// dashboard's GET received 1,000 of them. The Thursday batch was inserted last,
// its 302 memberships sat past the cut, and those readers rendered as belonging
// to no group -- while every row was in the database the whole time. The
// subscribers table (1,276) was truncating the same way, hiding 276 people.
//
// Any select over a table that can outgrow 1,000 rows must go through here.

export const PAGE_SIZE = 1000;

// A runaway guard, not a real ceiling: 200 pages is 200,000 rows, far past any
// list this system will hold, and it stops a bad range from looping forever.
const MAX_PAGES = 200;

type PageResult<T> = { data: T[] | null; error: { message: string } | null };

/**
 * Read every row by walking .range() until a short page comes back.
 *
 * The callback MUST end in a stable, UNIQUE .order(). Paging over a non-unique
 * sort lets Postgres return ties in a different order per request, which
 * silently duplicates some rows and drops others -- a subtler version of the
 * bug this function exists to fix.
 */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const out: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const from = i * PAGE_SIZE;
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) return { data: out, error };
    const rows = data ?? [];
    out.push(...rows);
    // A short page means the end of the table. An exactly-full page is
    // ambiguous, so it costs one more round trip to be sure.
    if (rows.length < PAGE_SIZE) return { data: out, error: null };
  }
  return {
    data: out,
    error: { message: `fetchAllRows stopped at ${MAX_PAGES} pages (${out.length} rows)` },
  };
}
