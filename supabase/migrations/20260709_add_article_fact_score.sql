-- AI fact-check score per article.
-- fact_score : 0-100 aggregate computed deterministically from per-claim verdicts
--              (see supabase/functions/_shared/fact-check.ts) — NOT a raw LLM number.
-- fact_label : human-readable band ("verified" | "mostly-factual" | "mixed" | "unverified").
-- fact_notes : audit trail — extracted claims, per-claim verdicts, credibility signals,
--              and a one-line rationale shown in the QA dashboard.
alter table public.articles add column if not exists fact_score numeric;
alter table public.articles add column if not exists fact_label text;
alter table public.articles add column if not exists fact_notes jsonb;
