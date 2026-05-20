# Shortly AI Emailer

A clean Shortly-style dashboard and Supabase email agent for sending one scraped article at a time to every active subscriber.

## What is included

- `index.html`, `styles.css`, `app.js`: static dashboard with article compose, scraper handoff, subscriber flow, and email preview.
- `supabase/schema.sql`: subscribers, articles, and per-recipient delivery logs with service-role policies.
- `supabase/functions/send-article/index.ts`: Supabase Edge Function that stores one article, fetches subscribed users, sends email through Resend, and logs delivery results.
- `src/scraper-adapter.ts`: small adapter your scraper can call once it has one article payload.

## Article payload

```json
{
  "title": "Article title",
  "url": "https://source/article",
  "summary": "Short subscriber-ready summary",
  "source": "Publication",
  "topic": "AI",
  "note": "Optional intro note"
}
```

## Supabase setup

1. Run `supabase/schema.sql` in your Supabase SQL editor.
2. Deploy the function in `supabase/functions/send-article`.
3. Set function secrets:

```bash
supabase secrets set SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY"
supabase secrets set RESEND_API_KEY="YOUR_RESEND_KEY"
supabase secrets set FROM_EMAIL="Shortly Digest <digest@yourdomain.com>"
```

## Connect the UI

Add this before `app.js` in `index.html`, or inject it from your hosting layer:

```html
<script>
  window.SHORTLY_EMAIL_ENDPOINT = "https://YOUR_PROJECT.functions.supabase.co/send-article";
</script>
```

## Connect the scraper

After your scraping code creates one article object, call:

```ts
import { sendScrapedArticle } from "./src/scraper-adapter";

await sendScrapedArticle(article, "https://YOUR_PROJECT.functions.supabase.co/send-article");
```

The function intentionally sends one article per request.
