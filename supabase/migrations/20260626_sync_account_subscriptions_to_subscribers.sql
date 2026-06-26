-- Bridge the website's account model (newsletter_subscriptions, written by the
-- daily-mattr /subscribe page) to the email agent's subscribers table. On any
-- change to a user's account subscriptions, recompute their subscribers row so
-- the dashboard reflects them and send-newsletter can reach them.
--
-- subscribers.topics holds the dashboard's topic SLUGS for EVERY product the user
-- is subscribed to: daily-wrap (General), corporate-case, real-estate,
-- policy-partner, money-matters, wellness-daily. (send-newsletter itself reads
-- newsletter_subscriptions directly for per-product sends; topics drives the
-- dashboard display + counts.) Best-fit plan/category retained for legacy paths.
-- Manual-only subscribers (no account rows) never trigger this, so they're safe.

create or replace function public.sync_account_to_subscriber()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := coalesce(new.user_id, old.user_id);
  v_email text;
  v_name text;
  v_active int;
  v_has_wrap boolean;
  v_has_case boolean;
  v_cat_slugs text[];
  v_send_days text[];
  v_news_cats text[];
  v_topics text[];
  v_primary_category text;
  v_plan text;
  v_status text;
begin
  if v_user is null then
    return coalesce(new, old);
  end if;

  select email, full_name into v_email, v_name from public.profiles where id = v_user;
  if v_email is null then
    select email into v_email from auth.users where id = v_user;
  end if;
  if v_email is null then
    return coalesce(new, old);
  end if;

  select
    count(*) filter (where status = 'active'),
    coalesce(bool_or(status = 'active' and newsletter_type = 'news_rhythm'), false),
    coalesce(bool_or(status = 'active' and newsletter_type = 'case_study_daily'), false)
  into v_active, v_has_wrap, v_has_case
  from public.newsletter_subscriptions
  where user_id = v_user;

  select
    coalesce(array_remove(array_agg(distinct category_slug), null), '{}'),
    coalesce(array_remove(array_agg(distinct weekday), null), '{}')
  into v_cat_slugs, v_send_days
  from public.newsletter_subscriptions
  where user_id = v_user and status = 'active' and newsletter_type = 'category_small_articles';

  select coalesce(array_remove(array_agg(distinct category_slug), null), '{}')
  into v_news_cats
  from public.newsletter_subscriptions
  where user_id = v_user and status = 'active' and newsletter_type = 'news_rhythm';

  -- Dashboard topic slugs for EVERY active product.
  select coalesce(array_remove(array_agg(distinct
    case
      when newsletter_type = 'news_rhythm' then 'daily-wrap'
      when newsletter_type = 'case_study_daily' then 'corporate-case'
      when newsletter_type = 'category_small_articles' then category_slug
    end
  ), null), '{}')
  into v_topics
  from public.newsletter_subscriptions
  where user_id = v_user and status = 'active';

  v_primary_category := case
    when array_length(v_cat_slugs, 1) >= 1
      then (select name from public.newsletter_categories where slug = v_cat_slugs[1])
    else null
  end;

  v_plan := case
    when array_length(v_cat_slugs, 1) >= 1 and v_has_case then 'category-case'
    when array_length(v_cat_slugs, 1) >= 1 then 'wrap-category'
    when v_has_case then 'case-only'
    else 'daily-wrap'
  end;

  if v_plan = 'case-only' and v_primary_category is null then
    v_primary_category := 'Corporate Case';
  end if;

  v_status := case when v_active > 0 then 'subscribed' else 'unsubscribed' end;

  insert into public.subscribers
    (email, full_name, status, plan, category, send_days, news_categories, topics, updated_at)
  values
    (v_email, v_name, v_status, v_plan, v_primary_category,
     coalesce(v_send_days, '{}'), coalesce(v_news_cats, '{}'), coalesce(v_topics, '{}'), now())
  on conflict (email) do update set
    full_name = coalesce(excluded.full_name, public.subscribers.full_name),
    status = excluded.status,
    plan = excluded.plan,
    category = excluded.category,
    send_days = excluded.send_days,
    news_categories = excluded.news_categories,
    topics = excluded.topics,
    updated_at = now();

  return coalesce(new, old);
end;
$$;

drop trigger if exists sync_account_to_subscriber_trigger on public.newsletter_subscriptions;
create trigger sync_account_to_subscriber_trigger
after insert or update or delete on public.newsletter_subscriptions
for each row execute function public.sync_account_to_subscriber();
