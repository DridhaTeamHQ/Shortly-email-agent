# Shortly AI Emailer

Automated daily news digest with a QA-in-the-loop.

**Pipeline:** RSS scrape → GPT-4o summarize → human QA (edit/approve/reject) → daily email with the top 10 approved stories to every active subscriber.

## What's in here

- `index.html`, `styles.css`, `app.js` — dashboard with **Compose**, **Review queue**, **Scraper**, **History** views.
- `supabase/schema.sql` — subscribers, articles (with status workflow), per-recipient delivery log, digest log.
- `supabase/cron.sql` — pg_cron schedule for scrape / summarize / send.
- `supabase/functions/`
  - `scrape-news` — pulls TOI, ET, and The Hindu RSS feeds, dedupes by URL, inserts `pending` rows.
  - `summarize-articles` — calls GPT-4o on pending rows, ranks top 50, promotes to `summarized`.
  - `list-articles` — feeds the QA dashboard (`?status=summarized|approved|rejected|sent`).
  - `review-article` — accepts `approve | reject | edit` actions from the dashboard.
  - `send-daily-digest` — picks top 10 `approved` articles, renders one polished HTML email, fans out via Resend, logs deliveries, marks `sent`.
  - `send-article` — legacy single-article send (still works for manual one-offs).
- `src/scraper-adapter.ts` — adapter for external scrapers that already produce a finished payload.

## Article status flow

```
pending  →  summarized  →  approved  →  sent
                       ↘   rejected
```

## Setup

1. `cp .env.example .env` and fill in real values.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Set function secrets (mirror your `.env`):
   ```bash
   supabase secrets set SUPABASE_URL="..." SUPABASE_SERVICE_ROLE_KEY="..." \
     RESEND_API_KEY="..." FROM_EMAIL="Shortly Digest <digest@yourdomain.com>" \
     OPENAI_API_KEY="..." OPENAI_MODEL="gpt-4o"
   ```
4. Deploy functions:
   ```bash
   supabase functions deploy scrape-news summarize-articles list-articles review-article send-daily-digest send-article
   ```
5. Edit `supabase/cron.sql` — replace `<PROJECT_REF>` and `<SERVICE_ROLE_KEY>` — then run it in the SQL editor.
6. In `index.html` (or your hosting layer), inject the endpoints before `app.js`:
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

## Default cron (UTC)

| Time  | Job                  | Function              |
| ----- | -------------------- | --------------------- |
| 07:00 | Scrape sources       | `scrape-news`         |
| 07:30 | Summarize w/ GPT-4o  | `summarize-articles`  |
| 15:00 | Send approved digest | `send-daily-digest`   |

QA window: 07:30 – 15:00 UTC. Adjust to your team's timezone in `cron.sql`.

## QA dashboard

Open the dashboard → **Review queue** tab. For each `summarized` article you can:
- Edit the summary inline → **Save edit**
- **✓ Approve** (only approved articles get sent)
- **✗ Reject** (article is dropped)

Top of the panel has **Run scrape**, **Summarize**, and **Send today's digest** buttons for manual runs.

## Sources

Configured in `supabase/functions/_shared/sources.ts` — TOI, ET, and The Hindu. Add or remove RSS URLs there.
