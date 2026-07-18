-- 0045: index events.parent_event_id.
--
-- events.parent_event_id is a self-referential FK (the causal chain) with no
-- index. Postgres has to verify no other row still points at an event before
-- it's removed, and without an index that's a full table scan of `events`
-- per row deleted. Confirmed live: deleting a workspace's events via
-- prune_events() (the only sanctioned delete path, see 0039) timed out even
-- in small time-windowed batches once the events table had tens of thousands
-- of rows. Pure performance fix, no behavior change.

create index if not exists events_parent_event_idx on events(parent_event_id) where parent_event_id is not null;
