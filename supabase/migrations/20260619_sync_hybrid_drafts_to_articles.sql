create or replace function public.sync_hybrid_editorial_draft_to_articles()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.format <> 'hybrid'
    or new.topic_slug not in ('real-estate', 'policy-partner', 'money-matters', 'wellness-daily')
    or jsonb_array_length(coalesce(new.briefing_items, '[]'::jsonb)) = 0 then
    return new;
  end if;

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
  select
    left(coalesce(brief.item->>'headline', new.headline), 500),
    coalesce(
      nullif(brief.item->>'source_url', ''),
      new.primary_source_url,
      'https://shortly.local/editorial/' || new.id::text
    ) || '#shortly-brief-' || brief.ord::text,
    trim(concat_ws(E'\n\n',
      case
        when nullif(brief.item->>'city', '') is not null
          then (brief.item->>'city') || ': ' || coalesce(brief.item->>'what_happened', '')
        else coalesce(brief.item->>'what_happened', '')
      end,
      brief.item->>'why_it_matters'
    )),
    trim(concat_ws(E'\n\n',
      case
        when nullif(brief.item->>'city', '') is not null
          then (brief.item->>'city') || ': ' || coalesce(brief.item->>'what_happened', '')
        else coalesce(brief.item->>'what_happened', '')
      end,
      brief.item->>'why_it_matters'
    )),
    coalesce(
      (
        select link->>'source'
        from jsonb_array_elements(coalesce(new.source_links, '[]'::jsonb)) link
        where link->>'url' = brief.item->>'source_url'
        limit 1
      ),
      new.topic_name
    ),
    case
      when new.topic_slug = 'real-estate' then 'Real Estate'
      when new.topic_slug = 'policy-partner' then 'Policy Partner'
      when new.topic_slug = 'money-matters' then 'Money Matters'
      when new.topic_slug = 'wellness-daily' then 'Wellness Daily'
      else new.topic_name
    end,
    case
      when new.topic_slug = 'real-estate' then 'Real Estate'
      when new.topic_slug = 'policy-partner' then 'Policy Partner'
      when new.topic_slug = 'money-matters' then 'Money Matters'
      when new.topic_slug = 'wellness-daily' then 'Wellness Daily'
      else new.topic_name
    end,
    'wrapped',
    'summarized',
    0.9,
    now(),
    now()
  from jsonb_array_elements(new.briefing_items) with ordinality as brief(item, ord)
  where nullif(brief.item->>'headline', '') is not null
  on conflict (url) do nothing;

  return new;
end;
$$;

drop trigger if exists sync_hybrid_editorial_draft_to_articles_trigger on public.editorial_drafts;

create trigger sync_hybrid_editorial_draft_to_articles_trigger
after insert or update of briefing_items on public.editorial_drafts
for each row
execute function public.sync_hybrid_editorial_draft_to_articles();
