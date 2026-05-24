-- Composio OAuth connections per workspace.
-- One row per (workspace, toolkit) pair (e.g. workspace X's Gmail account).
-- Composio holds the actual tokens; we store the linkage + last-known status
-- so the UI and the agent know what's wired up without round-tripping to
-- Composio on every read.

create table composio_connections (
  id                      uuid primary key default uuid_generate_v4(),
  workspace_id            uuid not null references workspaces(id) on delete cascade,
  toolkit_slug            text not null,                       -- 'gmail' | 'slack' | 'salesforce' | ...
  composio_connection_id  text,                                -- Composio's connected_account id, null until OAuth completes
  composio_user_id        text not null,                       -- the userId we pass to Composio (== workspace_id, namespaced)
  status                  text not null default 'initiated',   -- 'initiated' | 'active' | 'expired' | 'failed' | 'inactive'
  connect_url             text,                                -- redirect URL returned by authorize(), cached so UI can re-open it
  profile                 jsonb not null default '{}'::jsonb,  -- user-profile snapshot pulled after OAuth completes (email, display_name, etc.)
  last_error              text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (workspace_id, toolkit_slug)
);

create index composio_connections_workspace_idx
  on composio_connections(workspace_id, status);
create index composio_connections_composio_id_idx
  on composio_connections(composio_connection_id);

create trigger composio_connections_set_updated_at
  before update on composio_connections
  for each row execute function set_updated_at();

alter table composio_connections enable row level security;

create policy composio_connections_member_read on composio_connections for select
  using (
    workspace_id in (
      select workspace_id from workspace_members where user_id = auth.uid()
    )
  );

-- Writes via service-role only. No INSERT/UPDATE/DELETE policy.
