-- Preserve approved content as database history.
-- The dashboard and send functions already filter approved content to the
-- current IST day, so old approved rows can remain stored without appearing in
-- the email agent or being selected for future sends.

create or replace function public.shortly_cleanup_daily_review_pools()
returns void
language plpgsql
security definer
as $$
declare
  ist_start timestamptz;
begin
  ist_start := ((now() at time zone 'Asia/Kolkata')::date at time zone 'Asia/Kolkata');

  delete from public.articles
  where status in ('pending', 'summarized', 'rejected')
    and coalesce(reviewed_at, summarized_at, scraped_at, created_at) < ist_start;

  delete from public.editorial_drafts
  where status in ('draft', 'rejected')
    and coalesce(updated_at, generated_at, created_at) < ist_start;
end;
$$;

grant execute on function public.shortly_cleanup_daily_review_pools() to service_role;
