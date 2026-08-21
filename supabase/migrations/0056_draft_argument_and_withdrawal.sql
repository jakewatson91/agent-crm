-- A draft records which argument it made, and can be taken back without being
-- destroyed.
--
-- Two things were missing and they turned out to be the same gap.
--
-- 1. Nothing recorded WHAT a message argued. The angle picker chooses a problem
--    before every draft and hands it to the prompt, and then it is gone: the
--    stored post has a body, cites and a timestamp, so "which argument did we
--    make to this account" was only answerable by reading the prose. That is why
--    26 drafts in a week could all make the same wrong argument with nothing
--    noticing. With the id stored it is a query, and reply rate per argument
--    becomes a real number the moment replies exist.
--
-- 2. There was no way to take a draft back. Deleting loses the evidence, and
--    leaving it in place is worse than either: loadUsedAnchorIds reads the cites
--    of every touch_draft on the channel and excludes those facts from ever
--    being an anchor again, so a bad draft permanently silences the event it was
--    written about. Measured on Sudden the day this was added: 71 drafts had
--    burned 114 facts, and 33 of those were still inside the 30-day window. Nine
--    of the ten best accounts in the book could never be written to about the
--    launch that made them interesting.
--
-- Withdrawal is therefore a correction, not a delete: the body stays for
-- comparison, the reason says what was wrong with the ARGUMENT rather than the
-- prose, and the anchors go back in the pool.

alter table channel_posts
  add column if not exists argument_id      text,
  add column if not exists withdrawn_at     timestamptz,
  add column if not exists withdrawn_reason text;

comment on column channel_posts.argument_id is
  'policy.drafter.arguments[].id this draft applied. Null on posts that are not drafts, and on drafts written before arguments existed.';
comment on column channel_posts.withdrawn_at is
  'Set when a human takes a draft back. A withdrawn draft keeps its body but stops burning its anchors — see loadUsedAnchorIds.';
comment on column channel_posts.withdrawn_reason is
  'Why it was withdrawn, in plain words. This is a label on the ARGUMENT, not a note about the wording.';

-- The anchor-release read: every anchor lookup filters on withdrawn_at, so this
-- is the index that keeps it from scanning a channel's whole history.
create index if not exists channel_posts_live_drafts_idx
  on channel_posts(channel_id)
  where kind = 'touch_draft' and withdrawn_at is null;

-- Per-argument counts, for the record an argument carries.
create index if not exists channel_posts_argument_idx
  on channel_posts(argument_id)
  where argument_id is not null;
