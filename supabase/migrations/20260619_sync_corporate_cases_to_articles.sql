create or replace function public.sync_corporate_case_to_articles()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.articles (
    title,
    url,
    raw_content,
    summary,
    source,
    topic,
    category,
    section,
    status,
    rank_score,
    scraped_at,
    summarized_at
  )
  values (
    left(new.headline, 500),
    new.source_url || '#shortly-corporate-case-' || new.id::text,
    trim(concat_ws(E'\n\n', new.summary, new.detail)),
    trim(new.summary),
    new.source,
    'Corporate Case',
    'Corporate Case',
    'wrapped',
    'summarized',
    0.9,
    now(),
    now()
  )
  on conflict (url) do update
  set
    title = excluded.title,
    raw_content = excluded.raw_content,
    summary = excluded.summary,
    source = excluded.source,
    topic = excluded.topic,
    category = excluded.category,
    summarized_at = excluded.summarized_at;

  return new;
end;
$$;

drop trigger if exists sync_corporate_case_to_articles_trigger on public.corporate_cases;

create trigger sync_corporate_case_to_articles_trigger
after insert or update of headline, summary, detail, status on public.corporate_cases
for each row
execute function public.sync_corporate_case_to_articles();
