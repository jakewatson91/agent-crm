-- 0049: index every child table's source_event_id.
--
-- Third instance of the same defect (0045 events.parent_event_id, 0048
-- facts.supersedes): a foreign key with no index on the referencing column.
-- Here it is the child side. Before Postgres can delete an `events` row it must
-- prove no child still points at it, and with no index that is a sequential
-- scan of each child table PER ROW DELETED.
--
-- Measured live, cost of the FK check for one event id:
--
--   signals         SEQ SCAN   2611.355 ms
--   channel_posts   SEQ SCAN    435.691 ms
--   gates           SEQ SCAN     25.401 ms
--   conversations   SEQ SCAN      2.634 ms
--
-- About three seconds of enforcement to delete a single event. prune_events()
-- (the only sanctioned delete path, see 0039) is meant to remove tens of
-- thousands of rows on a retention run, so retention was effectively unusable:
-- it would time out long before finishing, which is exactly the failure 0045
-- was written for. Worth noting no workspace except the demo one has a
-- retention policy set, so this had never been exercised at volume.
--
-- Partial, because these columns are frequently null and only non-null rows can
-- block a delete. Pure performance, no behavior change, safe to re-run.
create index if not exists signals_source_event_idx
  on signals(source_event_id) where source_event_id is not null;

create index if not exists channel_posts_source_event_idx
  on channel_posts(source_event_id) where source_event_id is not null;

create index if not exists gates_source_event_idx
  on gates(source_event_id) where source_event_id is not null;

create index if not exists conversations_source_event_idx
  on conversations(source_event_id) where source_event_id is not null;

create index if not exists touches_source_event_idx
  on touches(source_event_id) where source_event_id is not null;

create index if not exists outcomes_source_event_idx
  on outcomes(source_event_id) where source_event_id is not null;
