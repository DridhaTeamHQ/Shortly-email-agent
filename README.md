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
  - `corporate-case-agent` - selects one source-backed Indian company case from the last five days and drafts the 400-600 word Corporate Case format for editor review.
  - `editorial-topic-agent` - builds Real Estate, Policy Partner, Money Matters, and Wellness drafts with topic-specific sources, formats, safety rules, and editor checklists.
  - `send-article` - legacy single-article send (still works for manual one-offs).
- `src/scraper-adapter.ts` - adapter for external scrapers that already produce a finished payload.

## Article status flow

```text
pending  ->  summarized  ->  approved  ->  sent
                       \->  rejected
```

## Setup

1. Copy `.env.example` to `.env` and fill in real values.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Set function secrets:
   ```bash
   supabase secrets set SUPABASE_URL="..." SUPABASE_SERVICE_ROLE_KEY="..." \
     AWS_REGION="ap-south-1" AWS_ACCESS_KEY_ID="..." AWS_SECRET_ACCESS_KEY="..." \
     SHORTLY_AGENT_SHARED_TOKEN="YOUR_SHARED_LOGIN_TOKEN" \
     FROM_EMAIL="Team Dailymattr <team@dailymattr.com>" \
     OPENAI_API_KEY="..." OPENAI_MODEL="gpt-4o"
   ```
4. Optional fallback while testing:
   ```bash
   supabase secrets set SMTP_PASS="YOUR_BREVO_API_KEY"
   ```
5. Deploy functions:
   ```bash
   supabase functions deploy scrape-news summarize-articles list-articles review-article send-daily-digest send-article corporate-case-agent editorial-topic-agent
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
     window.SHORTLY_CORPORATE_CASE_ENDPOINT = "https://YOUR_PROJECT.functions.supabase.co/corporate-case-agent";
     window.SHORTLY_EDITORIAL_TOPICS_ENDPOINT = "https://YOUR_PROJECT.functions.supabase.co/editorial-topic-agent";
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

Corporate Case sources are configured separately in `supabase/functions/_shared/corporate-case-sources.ts`: The Ken, Inc42, Moneycontrol business reporting, and ET Prime. The weekday cron runs at 10:00 IST and stores each generated draft in `corporate_cases` for editor review.

The additional editorial topics are configured in `supabase/functions/_shared/editorial-topics.ts`. Real Estate and Money Matters use the five-brief-plus-feature hybrid; Policy Partner and The Wellness Daily use the 100-word summary plus 300-500-word detail structure. They run Monday-Saturday on staggered schedules and store drafts in `editorial_drafts`.
