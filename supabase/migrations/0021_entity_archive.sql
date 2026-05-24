-- Soft-delete column for entities.
--
-- Set when a sweep job (or an agent post-processor) decides an entity is
-- low-signal junk: created by a connector, never accumulated facts, signals
-- or posts after some grace period. Filtering archived rows from the index,
-- search and detail surfaces is what cleans up connector pollution without
-- destroying audit history.
--
-- We do NOT delete the row — events / facts / posts may still reference it,
-- and replay needs them intact.

alter table entities
  add column archived_at timestamptz null;

create index entities_workspace_active_idx
  on entities(workspace_id, kind)
  where archived_at is null;

comment on column entities.archived_at is
  'Soft-delete: when set, entity is hidden from index/search but row + history remain for audit/replay.';
