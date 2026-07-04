-- New consumer subscription model (delivery rhythm + multi-category + source pref).
-- Additive and backward-compatible: the old plan/category/topics columns stay.

alter table public.subscribers
  add column if not exists rhythm text not null default 'daily',
  add column if not exists send_days text[] not null default '{}',          -- weekly: chosen weekdays (mon..sun)
  add column if not exists news_categories text[] not null default '{}',    -- subset of the 7 category slugs
  add column if not exists source_preference text not null default 'top';   -- top | mixed | wide

alter table public.subscribers drop constraint if exists subscribers_rhythm_check;
alter table public.subscribers add constraint subscribers_rhythm_check
  check (rhythm in ('daily', 'weekly', 'bi-weekly', 'monthly'));

alter table public.subscribers drop constraint if exists subscribers_source_pref_check;
alter table public.subscribers add constraint subscribers_source_pref_check
  check (source_preference in ('top', 'mixed', 'wide'));

create index if not exists subscribers_rhythm_idx
  on public.subscribers (rhythm) where status = 'subscribed';
