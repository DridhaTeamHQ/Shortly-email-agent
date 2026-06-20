alter table public.subscribers
  add column if not exists plan text not null default 'daily-wrap',
  add column if not exists category text;

alter table public.subscribers
  drop constraint if exists subscribers_plan_check;
alter table public.subscribers
  add constraint subscribers_plan_check
  check (plan in ('daily-wrap','category-case','wrap-category','case-only'));

alter table public.subscribers
  drop constraint if exists subscribers_category_check;
alter table public.subscribers
  add constraint subscribers_category_check
  check (category is null or category in ('Real Estate','Policy Partner','Money Matters','Wellness Daily','Corporate Case'));

-- Every non-daily-wrap plan requires a category.
alter table public.subscribers
  drop constraint if exists subscribers_plan_category_check;
alter table public.subscribers
  add constraint subscribers_plan_category_check
  check (plan = 'daily-wrap' or category is not null);

create index if not exists subscribers_plan_category_idx
  on public.subscribers (plan, category) where status = 'subscribed';
