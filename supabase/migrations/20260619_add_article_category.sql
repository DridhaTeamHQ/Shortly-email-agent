alter table public.articles
add column if not exists category text;

create index if not exists articles_category_status_idx
  on public.articles (category, status, scraped_at desc);
