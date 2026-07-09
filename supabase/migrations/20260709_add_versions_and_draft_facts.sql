-- Reader-facing alternate versions, generated once at approval time and shown
-- on the website (longmattr) reader: { eli5, tldr[], deep_dive, key_numbers[],
-- generated_at }. See supabase/functions/_shared/versions.ts.
alter table public.articles add column if not exists versions jsonb;

-- Long reads (editorial_drafts) get the same reader features as short articles:
-- an AI fact score (graded at approval against the primary source) and the
-- alternate versions. Columns mirror public.articles.
alter table public.editorial_drafts add column if not exists fact_score numeric;
alter table public.editorial_drafts add column if not exists fact_label text;
alter table public.editorial_drafts add column if not exists fact_notes jsonb;
alter table public.editorial_drafts add column if not exists versions jsonb;
