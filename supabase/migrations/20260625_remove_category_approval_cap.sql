-- QA approval pools are intentionally larger than the email send caps.
-- Sending chooses 5 category articles or 1 case study later; approval should not block at 10.

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
     ('Real Estate', 'Policy Partner', 'Money Matters', 'Wellness Daily', 'Corporate Case') then
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

grant execute on function public.review_article_category_safe(uuid, text, text, text, text, text, text) to anon, authenticated, service_role;
