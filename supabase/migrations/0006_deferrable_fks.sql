-- agent-crm v0 fix: make events.workspace_id FK deferrable so create_workspace
-- can write the event row and the workspaces row in the same record_event() tx.
-- Without this, the event insert fails the FK before the workspace row exists.
--
-- DEFERRABLE INITIALLY DEFERRED checks at commit time; rows can be inserted in any order
-- within a single transaction.

alter table events
  drop constraint events_workspace_id_fkey,
  add constraint events_workspace_id_fkey
    foreign key (workspace_id) references workspaces(id) on delete cascade
    deferrable initially deferred;

-- Same for workspace_members which is also touched at workspace bootstrap (future).
alter table workspace_members
  drop constraint workspace_members_workspace_id_fkey,
  add constraint workspace_members_workspace_id_fkey
    foreign key (workspace_id) references workspaces(id) on delete cascade
    deferrable initially deferred;
