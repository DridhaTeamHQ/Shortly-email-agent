-- Corporate Case items are managed in the Case Studies workspace only.
-- Remove the old mirror that copied corporate_cases into public.articles,
-- then clean up the duplicate short-article rows it already created.

drop trigger if exists sync_corporate_case_to_articles_trigger on public.corporate_cases;
drop function if exists public.sync_corporate_case_to_articles();

delete from public.articles
where category = 'Corporate Case'
   or topic = 'Corporate Case'
   or url like '%#shortly-corporate-case-%';
