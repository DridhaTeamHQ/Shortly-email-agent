alter table public.subscribers
add column if not exists topics text[] not null default array['daily-wrap']::text[];

update public.subscribers
set topics = array['daily-wrap']::text[]
where topics is null or array_length(topics, 1) is null;
