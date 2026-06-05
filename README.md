# Shortly AI Emailer

Automated daily news digest with a QA-in-the-loop.

**Pipeline:** RSS scrape -> GPT-4o summarize -> human QA (edit/approve/reject) -> daily email with the top 10 approved stories to every active subscriber.

## What's in here

- `index.html`, `styles.css`, `app.js` - dashboard with Compose, Review queue, Scraper, and History views.
- `supabase/schema.sql` - subscribers, articles (with status workflow), per-recipient delivery log, digest log.
- `supabase/cron.sql` - pg_cron schedule for scrape / summarize / send.
- `supabase/functions/`
  - `scrape-news` - pulls RSS feeds, dedupes by URL, inserts `pending` rows.
  - `summarize-articles` - calls GPT-4o on pending rows, ranks top 50, promotes to `summarized`.
  - `list-articles` - feeds the QA dashboard (`?status=summarized|approved|rejected|sent`).
  - `review-article` - accepts `approve | reject | edit` actions from the dashboard.
  - `send-daily-digest` - picks top 10 approved articles, renders one polished HTML email, fans out via Amazon SES (or Brevo fallback), logs deliveries, marks `sent`.
  - `send-article` - legacy single-article send (still works for manual one-offs).
- `src/scraper-adapter.ts` - adapter for external scrapers that already produce a finished payload.

## Article status flow

```text
pending  ->  summarized  ->  approved  ->  sent
                       \->  rejected
```

## Self-learning layer (RAG + optional fine-tuning)

The system learns from QA editorial decisions (approve/reject, headline & summary edits) and
feeds them back so summaries match house style and the queue surfaces the most likely keepers.

**Phase 1 — RAG (always on, no model training).** `summarize-articles` embeds each article
(`text-embedding-3-small`), retrieves the nearest *editor-rewritten* past examples via the
`match_articles` RPC and injects them as few-shot guidance, then computes an advisory
`suggestion_score` (0-100) from labelled neighbours. The dashboard shows a score badge and
auto-sorts the review queue best-first (humans still approve every article). Cold start is a
no-op: empty corpus → behaves exactly as before.

Setup:
1. Apply `supabase/migrations/20260605_add_rag_layer.sql` (pgvector, `embedding`,
   `suggestion_score/meta`, `prominence`, HNSW index, `match_articles` RPC, `app_config`).
2. `supabase secrets set OPENAI_EMBED_MODEL="text-embedding-3-small"`.
3. One-time backfill so day 1 isn't empty: `npm run backfill`.
4. Redeploy `summarize-articles` and `list-articles`.

**Phase 2 — periodic fine-tuning (gated, manual).** Offline scripts, run when the corpus is
rich enough:
- `npm run export-training` — JSONL from editor-validated examples (refuses below 100).
- `npm run train-model -- training/shortly-YYYYMMDD.jsonl` — fine-tunes `gpt-4o-2024-08-06`,
  saves the result to `app_config.OPENAI_MODEL_CANDIDATE` (never the live model).
- `npm run eval-model` — base vs candidate side-by-side. Promote only if it wins, by setting
  `app_config.OPENAI_MODEL` to the candidate id (the function reads that at runtime; delete the
  row to roll back instantly — no redeploy).

## Setup

1. Copy `.env.example` to `.env` and fill in real values.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Set function secrets:
   ```bash
   supabase secrets set SUPABASE_URL="..." SUPABASE_SERVICE_ROLE_KEY="..." \
     AWS_REGION="ap-south-1" AWS_ACCESS_KEY_ID="..." AWS_SECRET_ACCESS_KEY="..." \
     SHORTLY_AGENT_SHARED_TOKEN="YOUR_SHARED_LOGIN_TOKEN" \
     FROM_EMAIL="Shortly Dailywrap <dailywrap@shortlyindia.com>" \
     OPENAI_API_KEY="..." OPENAI_MODEL="gpt-4o"
   ```
4. Optional fallback while testing:
   ```bash
   supabase secrets set SMTP_PASS="YOUR_BREVO_API_KEY"
   ```
5. Deploy functions:
   ```bash
   supabase functions deploy scrape-news summarize-articles list-articles review-article send-daily-digest send-article
   ```
6. Edit `supabase/cron.sql` - replace `<PROJECT_REF>` and `<SERVICE_ROLE_KEY>` - then run it in the SQL editor.
7. In `index.html` (or your hosting layer), inject the endpoints before `app.js`:
   ```html
   <script>
     window.SHORTLY_LIST_ENDPOINT      = "https://YOUR_PROJECT.functions.supabase.co/list-articles";
     window.SHORTLY_REVIEW_ENDPOINT    = "https://YOUR_PROJECT.functions.supabase.co/review-article";
     window.SHORTLY_DIGEST_ENDPOINT    = "https://YOUR_PROJECT.functions.supabase.co/send-daily-digest";
     window.SHORTLY_SCRAPE_ENDPOINT    = "https://YOUR_PROJECT.functions.supabase.co/scrape-news";
     window.SHORTLY_SUMMARIZE_ENDPOINT = "https://YOUR_PROJECT.functions.supabase.co/summarize-articles";
     window.SHORTLY_EMAIL_ENDPOINT     = "https://YOUR_PROJECT.functions.supabase.co/send-article";
     window.SHORTLY_REVIEWER           = "qa-username";
   </script>
   ```

## Shared login with Shortly Agents

- The dashboard now expects a shared token before it unlocks.
- It accepts the token either:
  - in the URL as `?token=...`
  - or via `window.postMessage({ type: "shortly-agent-token", token })`
- The token is verified by the `verify-agent-token` Edge Function using `SHORTLY_AGENT_AUTH_SECRET`.
- The accepted token format is `base64url(payload).base64url(hmac_sha256(payload, secret))`.
- `SHORTLY_AGENT_SHARED_TOKEN` is still supported as an optional legacy fallback.
- After successful verification, the dashboard stores the token locally and reuses the session on later visits.

## SES notes

- Verify your sending domain in Amazon SES before switching live traffic.
- Request production access in SES, otherwise you stay in sandbox mode.
- The shared mailer now prefers SES automatically when `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` are present.
- If those AWS variables are missing, it falls back to Brevo using `SMTP_PASS`.

## Default cron (UTC)

| Time  | Job                  | Function             |
| ----- | -------------------- | -------------------- |
| 07:00 | Scrape sources       | `scrape-news`        |
| 07:30 | Summarize w/ GPT-4o  | `summarize-articles` |
| 15:00 | Send approved digest | `send-daily-digest`  |

QA window: 07:30-15:00 UTC. Adjust to your team's timezone in `cron.sql`.

## QA dashboard

Open the dashboard -> Review queue. For each `summarized` article you can:
- Edit the summary inline -> Save
- Approve
- Reject

Top of the panel has Run scrape, Summarize, and Send buttons for manual runs.

## Sources

Configured in `supabase/functions/_shared/sources.ts`.
