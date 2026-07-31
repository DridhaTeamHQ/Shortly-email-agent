# Shortly Email Agent MVP Plan

## 1. MVP Objective

Build a reliable internal dashboard that lets the Shortly team scrape news, generate AI summaries, review/edit stories, manage subscribers, preview the email, and send a daily digest through a verified email provider.

The MVP is not a fully autonomous newsroom. The goal is a fast editorial assistant with human approval before sending.

## 2. MVP Definition

The MVP is complete when the team can:

1. Import or add subscribers.
2. Scrape and summarize daily articles.
3. Edit headlines and summaries.
4. Approve or reject articles.
5. Preview the exact email format.
6. Send to selected subscribers or all active subscribers.
7. Run the daily automation at the expected schedule.
8. Generate drafts for the additional editorial topics.
9. Check delivery and job failures when something breaks.

## 3. MVP Scope

### In Scope

- Admin dashboard.
- Shared token login through Shortly Agents.
- Subscriber management with name, email, and phone number.
- CSV/XLS/XLSX subscriber upload.
- Recipient checkbox selection.
- Article scraping.
- AI summarization.
- Article review queue.
- Edit headline and summary.
- Approve, reject, approve all, reject all.
- Email preview.
- Email sending through Amazon SES, with Brevo fallback.
- Delivery logs.
- Scheduled scrape, summarize, and send jobs.
- Corporate Case agent.
- Real Estate, Policy Partner, Money Matters, and Wellness topic agents.
- Basic source and job error visibility.

### Out Of Scope For MVP

- Public user accounts.
- Paid subscription management.
- Advanced analytics dashboard.
- A/B testing subject lines.
- Full unsubscribe preference center.
- Multi-newsletter subscriber segmentation.
- Drag-and-drop email builder.
- Automatic publishing without editor approval.
- Mobile app.
- Recommendation engine.

## 4. MVP Users

### Editor

Needs to review, correct, approve, and send the daily digest quickly.

### Operator

Needs to run scraping, upload subscribers, trigger topic agents, and check errors.

### Admin

Needs to configure email provider, Supabase secrets, cron jobs, and source lists.

## 5. MVP Milestones

## Phase 1: Core Dashboard

Goal: Make the dashboard usable for daily editorial work.

Tasks:

- Build dashboard layout with sections for Review, Subscribers, Scraper, History, and Analytics.
- Add shared login gate.
- Connect dashboard to Supabase Edge Functions.
- Add article search, topic filter, and section filter.
- Add status counters for review, approved, rejected, and subscribers.

Acceptance Criteria:

- Dashboard loads behind login.
- Review queue shows summarized articles.
- User can switch between dashboard sections.
- No protected action works without a valid token.

## Phase 2: Article Pipeline

Goal: Get articles from sources into editor review.

Tasks:

- Build `scrape-news` Edge Function.
- Configure approved RSS/source list.
- Dedupe articles by URL.
- Store raw article data in `articles`.
- Build `summarize-articles` Edge Function.
- Generate useful summaries, not one-line blurbs.
- Mark summarized stories as ready for review.

Acceptance Criteria:

- Manual scrape inserts new articles.
- Manual summarize creates summaries.
- Failed source fetches are reported.
- Duplicate URLs do not create duplicate rows.

## Phase 3: Human Review

Goal: Editors can control final content.

Tasks:

- Add approve and reject actions.
- Add approve all and reject all bulk actions.
- Add headline editing.
- Add summary editing.
- Add section selection.
- Preserve editor changes separately from AI output.

Acceptance Criteria:

- Editor can edit headline and summary.
- Edited version appears in preview and sent email.
- Approve all works for selected articles.
- Reject all works for selected articles.
- Rejected articles never appear in the email.

## Phase 4: Email Template

Goal: Preview and sent email match.

Tasks:

- Build email template matching current preview.
- Add banner image.
- Add intro text with subscriber name.
- Use Roboto Serif for headlines.
- Use Roboto for body text.
- Add footer logo and social links.
- Remove unwanted unsubscribe block from current MVP template.

Acceptance Criteria:

- Preview and sent email have the same structure.
- Banner loads in the sent email.
- Article numbering aligns correctly.
- Category labels are not shown in the email.
- Footer spacing is compact.

## Phase 5: Subscriber Management

Goal: Team can manage recipients without touching the database.

Tasks:

- Add subscriber form with email, name, and phone number.
- Add subscriber table.
- Add CSV/XLS/XLSX upload.
- Accept columns: `name`, `email`, `phone number`.
- Handle variants like `Name`, `Email`, `Phone No.`.
- Add recipient checkboxes.
- Add select all subscribed.
- Add clear selection.

Acceptance Criteria:

- Manual subscriber add works.
- Spreadsheet upload works with real team format.
- Invalid emails are skipped or reported.
- Selected-recipient sending works.
- If no recipient is selected, all subscribed users are eligible.

## Phase 6: Email Sending

Goal: Send reliably through a verified provider.

Tasks:

- Configure Amazon SES credentials.
- Support Brevo fallback.
- Set from email to `dailywrap@shortlyindia.com`.
- Set from name to `Shortly Dailywrap`.
- Add subject format: `Date - Shortly Daily Wrap is here !`.
- Log per-recipient delivery status.
- Store digest send record.

Acceptance Criteria:

- Manual send sends to intended recipients.
- Delivery log records sent and failed emails.
- Failed recipients do not block all sends.
- SES is used when AWS secrets are present.
- Brevo fallback only runs when SES is not configured.

## Phase 7: Automation

Goal: Daily pipeline runs without manual clicks.

Tasks:

- Add Supabase `pg_cron`.
- Add `public.invoke_edge` helper.
- Store auth token in Supabase Vault.
- Schedule scrape at 8:00 AM IST.
- Schedule summarize at 8:15 AM IST.
- Schedule send at 9:00 AM IST.
- Schedule topic agents after the daily email flow.

Acceptance Criteria:

- Cron jobs are active.
- Jobs call Edge Functions successfully.
- 9:00 AM send only sends approved/eligible articles.
- Job failures can be checked in Supabase.

## Phase 8: Editorial Topic Agents

Goal: Generate first drafts for repeatable editorial products.

Tasks:

- Build Corporate Case agent.
- Build shared editorial topic agent.
- Add Real Estate topic.
- Add Policy Partner topic.
- Add Money Matters topic.
- Add Wellness Daily topic.
- Add topic selector in dashboard.
- Store drafts in Supabase.
- Add source links, inference notes, and editor checklists.

Acceptance Criteria:

- Corporate Case generates a company-focused case.
- Real Estate generates five briefs plus one thesis.
- Money Matters generates five briefs plus one take and includes disclaimer.
- Policy Partner generates plain-English policy explanation.
- Wellness Daily includes safety lines when needed.
- Drafts include source links and editor checklist.

## 6. Technical Architecture

### Frontend

- Static dashboard hosted on Vercel.
- Files:
  - `index.html`
  - `app.js`
  - `styles.css`
  - `config.js`

### Backend

- Supabase Edge Functions.
- Supabase Postgres.
- Supabase Vault.
- Supabase `pg_cron`.

### AI

- OpenAI model for summarization and drafting.
- Structured JSON responses for topic agents.
- Programmatic validation for word counts and safety lines.

### Email

- Amazon SES primary.
- Brevo fallback.
- Delivery logs stored per recipient.

## 7. Important Tables

- `subscribers`
- `articles`
- `article_deliveries`
- `digests`
- `corporate_cases`
- `editorial_drafts`

## 8. Important Edge Functions

- `scrape-news`
- `summarize-articles`
- `list-articles`
- `review-article`
- `send-daily-digest`
- `send-article`
- `subscribers`
- `verify-agent-token`
- `corporate-case-agent`
- `editorial-topic-agent`

## 9. Launch Checklist

Before MVP launch:

- Supabase secrets are set.
- SES domain is verified.
- SES account is out of sandbox.
- SPF, DKIM, and DMARC are configured.
- From email shows as `Shortly Dailywrap <dailywrap@shortlyindia.com>`.
- Dashboard login works from Shortly Agents.
- CSV upload works with real subscriber file.
- Preview matches sent email.
- Manual send works for a small test group.
- 8:00, 8:15, and 9:00 AM jobs are active.
- Cron logs are checked after first scheduled run.
- Bounce/failure logs are visible.

## 10. MVP Testing Plan

### Functional Tests

- Add one subscriber manually.
- Upload a spreadsheet with at least 10 subscribers.
- Select one subscriber and send only to that person.
- Clear selection and confirm all subscribed users are eligible.
- Scrape articles.
- Summarize articles.
- Edit article headline.
- Edit article summary.
- Approve selected articles.
- Reject selected articles.
- Preview email.
- Send email.

### Automation Tests

- Trigger scrape job manually.
- Trigger summarize job manually.
- Trigger send job manually.
- Confirm cron jobs are active.
- Confirm next scheduled run time.
- Confirm scheduled job returns success.

### Email Tests

- Send to Gmail.
- Send to organization email.
- Check spam/promotions placement.
- Check banner image loading.
- Check from name.
- Check subject.
- Check mobile rendering.
- Check footer links.

### Topic Agent Tests

- Run Corporate Case.
- Run Real Estate.
- Run Policy Partner.
- Run Money Matters.
- Run Wellness Daily.
- Confirm each draft has correct structure.
- Confirm required disclaimer/safety lines are present.

## 11. MVP Risks

### Source Scraping Breaks

Some publishers block requests or change RSS feeds.

Mitigation:

- Keep source errors visible.
- Use fallback source lists.
- Do not generate drafts from empty or weak source pools.

### Email Deliverability Issues

Large subscriber volume can hurt reputation if setup is weak.

Mitigation:

- Use SES production access.
- Warm sending gradually.
- Track bounces and complaints.
- Keep domain authentication correct.

### AI Hallucination

AI may invent numbers, facts, or unsafe advice.

Mitigation:

- Use source-bound prompts.
- Store source links.
- Add validation rules.
- Keep editor approval mandatory.

### Wrong Recipient Sends

Operator may accidentally send to all subscribers.

Mitigation:

- Show send count clearly.
- Preserve recipient selection state.
- Add confirmation for large sends in future versions.

## 12. Post-MVP Roadmap

Priority 1:

- Dedicated review UI for `corporate_cases` and `editorial_drafts`.
- Job history page for cron and Edge Function results.
- Better source health dashboard.

Priority 2:

- Subscriber segmentation by newsletter/topic.
- Separate templates for each editorial product.
- Bounce and complaint suppression automation.
- Analytics for opens and clicks.

Priority 3:

- Team roles and permissions.
- Multi-editor workflow.
- Approval notes and version history.
- A/B subject line testing.

## 13. MVP Success Criteria

The MVP is successful if:

- Team sends the daily digest without manual formatting.
- Editor can complete review and send in under 15 minutes.
- Scheduled scrape and summarize jobs run daily.
- 9:00 AM send works for approved content.
- Subscriber upload and recipient selection work without developer help.
- At least one topic agent draft is usable by the editor each day.
- Delivery failures are visible and actionable.
