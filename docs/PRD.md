# Shortly Email Agent PRD

## 1. Product Summary

Shortly Email Agent is an editorial automation dashboard for creating, reviewing, and sending short, high-quality daily email digests. It combines RSS/source scraping, AI summarization, human review, subscriber management, and scheduled email sending.

The product is built for the Shortly editorial team to move faster without losing editorial control. AI drafts the first version; humans approve, edit, reject, and decide what gets sent.

## 2. Product Goals

- Produce a polished daily email digest with up to 10 approved stories.
- Reduce manual scraping, summarizing, and formatting work for editors.
- Keep a human QA layer before anything is sent to subscribers.
- Support multiple editorial products/topics from the same dashboard.
- Send emails reliably to selected subscribers or all active subscribers.
- Maintain source attribution, safety rules, and editorial consistency.

## 3. Target Users

- Editors: Review, edit, approve, reject, and send stories.
- Content operators: Run scraping, summarization, and topic agents.
- Growth/ops team: Manage subscribers, upload CSV files, and select recipients.
- Admins: Configure sending provider, schedules, sources, and access tokens.

## 4. Core Workflows

### 4.1 Daily News Digest

1. Scrape approved news sources.
2. Summarize scraped articles using GPT.
3. Load summarized stories into the review queue.
4. Editor edits headlines/summaries if needed.
5. Editor approves selected stories.
6. Send digest manually or through scheduled automation.
7. Log delivery status per subscriber.

### 4.2 Subscriber Management

1. Add subscriber manually with email, name, and phone number.
2. Upload CSV/XLS/XLSX with accepted columns: name, email, phone number.
3. Select specific recipients using checkboxes.
4. Send to selected recipients or all subscribed users.
5. Track subscribed, unsubscribed, bounced, sent, and failed states.

### 4.3 Editorial Topic Agents

The dashboard supports topic-specific agents:

- Corporate Case
- Industry: Real Estate
- Policy Partner
- Money Matters
- The Wellness Daily

Each agent has its own sources, format, voice rules, safety rules, and editor checklist. Drafts are stored for editor review.

## 5. Key Features

### 5.1 Dashboard

- Review queue with article status filters.
- Search and topic/section filters.
- Approve, reject, save edits, and bulk actions.
- Preview email before sending.
- Send digest manually.
- Subscriber table with selection controls.
- CSV upload for subscriber import.
- Scraper and topic-agent controls.

### 5.2 Email Rendering

- Email preview should match the actual sent email structure.
- Header uses current Shortly Daily Wrap banner.
- Intro copy:
  - `Hi <NAME>,`
  - `Here are 5 things that deserve your attention. The biggest stories, minus the noise. Grab your coffee -- you'll be caught up SHORTLY!`
- Article headlines use Roboto Serif.
- Normal body text uses Roboto.
- Footer uses Shortly logo and social links.
- No unsubscribe section unless explicitly re-enabled.

### 5.3 Email Sending

- Primary provider: Amazon SES.
- Fallback provider: Brevo, if configured.
- From email: `dailywrap@shortlyindia.com`.
- From name should appear as `Shortly Dailywrap`.
- Subject format: `Date - Shortly Daily Wrap is here !`
- Support sending to selected subscribers.
- Log each delivery attempt.

### 5.4 Automation

Current scheduled flow:

- 8:00 AM IST: Scrape daily news.
- 8:15 AM IST: Summarize pending articles.
- 9:00 AM IST: Send approved digest.
- 10:00 AM IST weekdays: Corporate Case agent.
- 10:10 AM IST Monday-Saturday: Real Estate agent.
- 10:20 AM IST Monday-Saturday: Policy Partner agent.
- 10:30 AM IST Monday-Saturday: Money Matters agent.
- 10:40 AM IST Monday-Saturday: Wellness Daily agent.

All schedules are implemented through Supabase `pg_cron` calling Edge Functions.

## 6. Editorial Requirements

### 6.1 Daily Digest Articles

- Use approved sources only.
- Summaries should be long enough to be useful, not one-line blurbs.
- Editors must be able to edit headlines and summaries.
- If no articles are selected for sending, system should fall back to remaining approved articles.
- Avoid duplicate or already-sent stories.

### 6.2 Corporate Case

- One Indian company case per issue.
- Summary around 100 words.
- Detail around 300-500 words.
- Total 400-600 words.
- Must include:
  - Company
  - Source link
  - Business model
  - Bull case
  - Bear case
  - Open question
  - Comparison or analogy
  - Editor checklist

### 6.3 Real Estate

- Hybrid format: five briefs plus one thesis.
- Focus on Indian real estate, major cities, builders, projects, infrastructure, and regulation.
- No invented EMIs, yields, appreciation numbers, or projections.
- Every number must trace to a source.

### 6.4 Policy Partner

- Explain Indian policy in plain English.
- Focus on money, rights, work, rent, or daily life.
- Use official/legal sources where possible.
- Neutral on parties, sharp on policy substance.
- Must include an example, comparison, parallel, or analogy.

### 6.5 Money Matters

- Hybrid format: five money briefs plus one take.
- No investment advice.
- No stock, product, fund, IPO, or return recommendations.
- Must end with:
  - `This isn't investment advice. We don't know your situation. Talk to a SEBI-registered advisor before acting on anything you read here.`

### 6.6 Wellness Daily

- Summary around 100 words.
- Detail around 300-500 words.
- Evidence-led and anti-wellness-hype.
- Indian context is mandatory.
- No drug doses, supplement brands, calorie targets, step-count goals, or weight-loss numbers.
- Mental health pieces must include:
  - `If you're struggling, iCall is a free confidential helpline: 9152987821.`
- Medical-condition pieces must include:
  - `This isn't medical advice. See a doctor for anything concerning you.`

## 7. Data Model

Important tables:

- `subscribers`: Email, name, phone number, status.
- `articles`: Scraped articles, summaries, edited content, review status.
- `article_deliveries`: Per-recipient send result.
- `digests`: Digest send logs.
- `corporate_cases`: Corporate Case drafts.
- `editorial_drafts`: Real Estate, Policy, Money, and Wellness drafts.

Important statuses:

- Articles: `pending`, `summarized`, `approved`, `rejected`, `sent`.
- Subscribers: `subscribed`, `unsubscribed`, `bounced`.
- Editorial drafts: `draft`, `approved`, `rejected`, `published`.

## 8. Integrations

- Supabase database.
- Supabase Edge Functions.
- Supabase Vault for scheduled function auth.
- Supabase `pg_cron` for automation.
- OpenAI for summarization and editorial drafting.
- Amazon SES for email delivery.
- Brevo as fallback email provider.
- Vercel for dashboard hosting.
- Shortly Agents for shared token login.

## 9. Access And Security

- Dashboard access should require a valid Shortly Agents token.
- Edge Functions should validate authorization for protected operations.
- Service role keys must never be exposed in browser code.
- Email provider credentials must stay in Supabase secrets.
- Subscriber data should not be exported or exposed publicly.
- CSV upload should validate email format and ignore invalid rows.

## 10. Success Metrics

- Daily scrape and summarize jobs complete successfully.
- 9:00 AM IST send job sends to intended recipients.
- Delivery failure rate stays low.
- Editor can prepare a digest in under 15 minutes.
- Email preview matches the sent email.
- CSV upload imports valid subscribers without breaking the UI.
- Topic agents generate usable drafts with correct structure and safety lines.

## 11. Non-Goals

- Fully automated publishing without human review.
- Stock or investment recommendations.
- Medical advice.
- Original reporting or fact generation.
- Paywall bypassing.
- Public subscriber directory or public admin dashboard.

## 12. Risks And Mitigations

- Source feeds break or block scraping.
  - Mitigation: Store source errors, use fallbacks, and show failures clearly.
- AI drafts become too short or miss safety lines.
  - Mitigation: Validate word counts and enforce required endings programmatically.
- Scheduled jobs silently fail.
  - Mitigation: Query cron/job logs and Edge Function responses after schedule changes.
- Email provider reputation issues.
  - Mitigation: Use verified domain, SPF/DKIM/DMARC, SES production access, and bounce tracking.
- Wrong recipients receive a test email.
  - Mitigation: Keep checkbox recipient selection visible and show send count before sending.

## 13. MVP Acceptance Criteria

- Editor can scrape, summarize, review, approve, preview, and send a digest.
- Subscriber add, CSV upload, phone number display, and recipient selection work.
- Sent email matches preview layout.
- SES sending works with `dailywrap@shortlyindia.com`.
- Scheduled 8:00, 8:15, and 9:00 IST jobs are active.
- Corporate Case and four editorial topic agents can be triggered manually.
- Topic agent drafts are stored in Supabase and include source links and editor checklists.
- GitHub main branch contains deployable code and setup documentation.

## 14. Next Priorities

- Add a dedicated review UI for `corporate_cases` and `editorial_drafts`.
- Add visible job history for scheduled scrape, summarize, send, and topic agents.
- Add stronger bounce/unsubscribe handling before scaling subscriber volume.
- Add per-topic send templates if editorial products become separate newsletters.
- Add source health dashboard showing failed feeds and last successful scrape.
