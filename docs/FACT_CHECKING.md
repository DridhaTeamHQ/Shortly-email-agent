# AI Fact Checking — how the fact score works

Every article Shortly publishes now carries a **fact score (0–100)**, computed by an
AI fact-check step that runs right after summarization in all three content
pipelines (`summarize-articles`, `editorial-topic-agent`, `corporate-case-agent`).

This document explains the method, why it is built this way, and how to extend it.
Reference product doing the same job for social video: [Only The Truth](https://onlythetruth.vercel.app/)
— it checks "every claim across hundreds of sources" and shows a per-scan verdict.
Our version applies the same claim-level idea to our own articles at newsletter scale.

## The research in one page

Automated fact-checking (AFC) literature converges on a three-stage pipeline —
this is how you "train" an AI to fact check without training a model at all:

1. **Claim extraction** — split the text into *atomic, checkable claims*
   (one actor, one action/figure each). Whole-article verdicts are unreliable;
   per-claim verdicts are what every serious system uses
   ([survey of LLM fact-checking](https://arxiv.org/pdf/2407.02351),
   [VERISCORE](https://arxiv.org/pdf/2406.19276)).
2. **Evidence verification** — grade each claim against evidence:
   *supported / partially-supported / unsupported / contradicted*
   (the retrieval-then-verify paradigm, e.g.
   [ClaimCheck](https://arxiv.org/abs/2510.01226),
   [AutoVerifier](https://arxiv.org/html/2604.02617)).
3. **Aggregation** — combine the per-claim verdicts into a score. Crucially,
   **never ask the model for the number directly**: LLM self-reported confidence
   is poorly calibrated ([FIRE](https://www.emergentmind.com/topics/llm-driven-fact-checking-process)).
   Ask for categorical verdicts; compute the number deterministically in code.

## Our implementation (`supabase/functions/_shared/fact-check.ts`)

One cheap-model JSON call per article does stages 1–2; stage 3 is plain code.

- **Evidence base = the article headline + the scraped body.** We measure
  *grounding*: is every claim in our summary actually present, with matching
  numbers, in the article we scraped? This catches the failure mode that matters
  most for an AI-written digest — the summarizer inventing or distorting a fact —
  without paid web-search retrieval. The **headline counts as valid evidence**:
  a fact stated only in the headline is "supported", not "unsupported".
- **Grounding needs real body text.** Thin RSS snippets were the main cause of
  spuriously low scores — grading a summary against a headline-length blurb makes
  true claims look unsupported. `summarize-articles` now fetches the full readable
  article body (trigger raised to <700 chars) before scoring, and the fact-checker
  grades against the fullest available text, never just the compact summary excerpt.
- **Credibility signals** on the source itself, each graded 0–2:
  *attribution* (named people/orgs/filings vs "reports say"), *specificity*
  (dates, figures, named actors), *tone* (sober register vs clickbait).
- **Deterministic score:** `70% × mean(claim credit) + 30% × signals`, where
  claim credit is supported = 1, partial = 0.55, unsupported = 0.15,
  contradicted = 0. Any contradicted claim **caps the score at 45** — a summary
  that gets a fact backwards can never wear a green badge.

| Score | Label | Meaning |
|---|---|---|
| 85–100 | `verified` | every claim grounded, well-attributed source |
| 65–84 | `mostly-factual` | gist solid, a figure/scope imperfectly grounded |
| 40–64 | `mixed` | unsupported claims present — review before approving |
| 0–39 | `unverified` | contradiction or mostly ungrounded — do not ship as-is |

Stored on `articles` as `fact_score` (numeric), `fact_label` (text), and
`fact_notes` (jsonb audit trail: claims + verdicts + signals + one-line rationale).

### Ranking favors grounded articles

`fact_score` is folded into each article's `rank_score`, so well-grounded stories
rise to the top of the review queue and the email auto-select, and weak ones sink:

- **General pipeline** (`summarize-articles`): `rank_score = 35% source + 25% prominence + 20% freshness + 20% fact`. Unscored articles use a neutral 0.6 fact prior.
- **Category & corporate pipelines**: `rank_score = source_weight × (0.7 + 0.6 × fact/100)` — a top-scored article ranks ~30% higher, a contradicted one ~30% lower.

Low scores are never silently dropped (that would hide real news) — they are
deprioritised and flagged for the reviewer instead.

## Where it surfaces

- **QA dashboard** — every card shows a color-banded `Fact NN` chip; hover shows
  the rationale and any non-supported claims. Reviewers see *why*, not just a number.
- **Newsletter** — articles scoring ≥ 65 get a "Fact-checked NN/100" badge.
  Weak/unscored articles carry no badge (the email never advertises doubt; low
  scores are for reviewers to catch upstream).

## Cost & controls

One extra `gpt-4o-mini` call (~380 output tokens) per article, always on the
cheap model regardless of the pipeline's summarize model. Failure is non-fatal:
an article that can't be scored ships with `fact_score = null`.

- `FACT_CHECK_ENABLED=false` — kill-switch, skips scoring entirely.
- `FACT_CHECK_MODEL` — override the model (defaults to `SUMMARIZE_MODEL`, then `gpt-4o-mini`).

## Extension path (in order of value)

1. **Cross-source corroboration** — we already scrape many feeds per category;
   claims from one article could be checked against sibling articles on the same
   story (free, no new APIs). Multi-source agreement is the biggest single
   accuracy win in the literature ([ZoFia](https://arxiv.org/pdf/2511.01188)).
2. **Web-retrieval verification** — add a search API and re-verify only the
   claims graded `unsupported` (adaptive verification: spend retrieval budget
   only where the cheap pass is uncertain).
3. **Fine-tuning / few-shot calibration** — log reviewer approve/reject
   decisions against fact scores; once a few hundred labeled pairs exist, use
   them as few-shot exemplars or to tune the aggregation weights. The QA
   dashboard already produces this training data as a side effect.
4. **Source reputation prior** — maintain a per-source rolling average of fact
   scores and blend it in as a prior for thin articles.
