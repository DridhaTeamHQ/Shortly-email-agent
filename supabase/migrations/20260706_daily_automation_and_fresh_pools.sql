-- Daily automation + fresh pool rules.
-- Keeps the dashboard pools aligned with the current five Shortly categories.

alter table public.subscribers
  drop constraint if exists subscribers_category_check;

alter table public.subscribers
  add constraint subscribers_category_check
  check (
    category is null or category in (
      'Real Estate',
      'Automobile',
      'Health & Wellness',
      'Tech & AI',
      'Markets & Startups',
      'Corporate Case'
    )
  );

alter table public.editorial_drafts
  drop constraint if exists editorial_drafts_topic_slug_check;

alter table public.editorial_drafts
  add constraint editorial_drafts_topic_slug_check
  check (
    topic_slug in (
      'real-estate',
      'automobile',
      'health-wellness',
      'tech-ai',
      'markets-startups',
      -- legacy values retained so old rows do not block the migration
      'policy-partner',
      'money-matters',
      'wellness-daily'
    )
  );

alter table public.editorial_drafts
  drop constraint if exists editorial_drafts_status_check;

alter table public.editorial_drafts
  add constraint editorial_drafts_status_check
  check (status in ('draft', 'approved', 'rejected', 'published'));

create or replace function public.review_article_category_safe(
  p_id uuid,
  p_action text,
  p_reviewer text default null,
  p_section text default null,
  p_category text default null,
  p_edited_title text default null,
  p_edited_summary text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_article public.articles%rowtype;
  v_category text;
begin
  if p_action not in ('approve', 'reject', 'edit') then
    raise exception 'action must be approve|reject|edit';
  end if;

  select * into v_article
  from public.articles
  where id = p_id;

  if not found then
    raise exception 'article not found';
  end if;

  v_category := nullif(trim(coalesce(p_category, v_article.category, '')), '');
  if v_category is not null and v_category not in
     ('Real Estate', 'Automobile', 'Health & Wellness', 'Tech & AI', 'Markets & Startups', 'Corporate Case') then
    v_category := null;
  end if;

  if p_action = 'approve' then
    update public.articles
    set
      status = 'approved',
      category = v_category,
      section = case when p_section in ('wrapped', 'ahead') then p_section else section end,
      edited_title = coalesce(nullif(trim(p_edited_title), ''), edited_title),
      edited_summary = coalesce(nullif(trim(p_edited_summary), ''), edited_summary),
      reviewed_at = now(),
      reviewed_by = p_reviewer
    where id = p_id
    returning * into v_article;
  elsif p_action = 'reject' then
    update public.articles
    set
      status = 'rejected',
      category = v_category,
      section = case when p_section in ('wrapped', 'ahead') then p_section else section end,
      reviewed_at = now(),
      reviewed_by = p_reviewer
    where id = p_id
    returning * into v_article;
  else
    update public.articles
    set
      category = v_category,
      section = case when p_section in ('wrapped', 'ahead') then p_section else section end,
      edited_title = coalesce(nullif(trim(p_edited_title), ''), edited_title),
      edited_summary = coalesce(nullif(trim(p_edited_summary), ''), edited_summary),
      reviewed_at = now(),
      reviewed_by = p_reviewer
    where id = p_id
    returning * into v_article;
  end if;

  return to_jsonb(v_article);
end;
$$;

grant execute on function public.review_article_category_safe(uuid, text, text, text, text, text, text)
  to anon, authenticated, service_role;

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
  where status in ('pending', 'summarized', 'approved', 'rejected')
    and coalesce(reviewed_at, summarized_at, scraped_at, created_at) < ist_start;

  delete from public.editorial_drafts
  where status in ('draft', 'approved', 'rejected')
    and coalesce(updated_at, generated_at, created_at) < ist_start;
end;
$$;

grant execute on function public.shortly_cleanup_daily_review_pools() to service_role;
