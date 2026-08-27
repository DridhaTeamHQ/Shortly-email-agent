-- A website account can be mirrored into subscribers before it visits the
-- public subscribe form. Track the first successful welcome so that contact
-- still receives the intro once, without sending duplicates on later edits.
alter table public.subscribers
  add column if not exists welcome_sent_at timestamptz;
