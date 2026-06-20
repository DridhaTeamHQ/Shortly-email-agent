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
  v_count integer;
  v_start timestamptz;
  v_end timestamptz;
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

  v_category := nullif(trim(coalesce(p_category, v_article.category, v_article.topic, '')), '');

  if p_action = 'approve' then
    v_start := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
    v_end := v_start + interval '1 day';

    select count(*) into v_count
    from public.articles
    where status = 'approved'
      and reviewed_at >= v_start
      and reviewed_at < v_end
      and (
        (v_category is null and category is null)
        or category = v_category
      );

    if v_count >= 10 then
      raise exception 'Daily approval limit reached for %', coalesce(v_category, 'uncategorised');
    end if;

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

grant execute on function public.review_article_category_safe(uuid, text, text, text, text, text, text) to anon, authenticated, service_role;
