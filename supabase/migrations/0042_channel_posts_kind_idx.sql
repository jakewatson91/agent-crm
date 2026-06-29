-- 0042: index channel_posts(kind, created_at desc).
--
-- The feed query now fetches "most recent N of kind X" in two separate windows
-- (apps/web/app/api/feed/list/route.ts) so a burst of claim/decision posts can't
-- push touch_draft/gate_request/outcome rows out of view. Without this index,
-- finding the most recent rows of a rare kind means scanning further and further
-- back as the table grows. channel_posts_channel_time_idx (channel_id,
-- created_at desc) doesn't help here since the kind filter isn't per-channel.

create index channel_posts_kind_time_idx on channel_posts(kind, created_at desc);
