-- Composio auth-config cache, global to the agent-crm deploy (not per workspace).
--
-- An auth config is what Composio needs server-side to OAuth a user into a
-- toolkit (Gmail, Slack, etc.). It's created once per toolkit and reused for
-- every end-user connect. We let agent-crm create them on demand via the SDK
-- (`composio.authConfigs.create(toolkit, { type: 'use_composio_managed_auth' })`)
-- the first time a workspace tries to connect that toolkit, then cache the id
-- here so subsequent connects don't re-create.
--
-- One row per toolkit_slug. No workspace_id — these are deploy-wide.

create table composio_auth_configs (
  toolkit_slug          text primary key,                  -- 'gmail' | 'slack' | ...
  composio_auth_config_id text not null,                   -- 'ac_xxx' from Composio
  is_composio_managed   bool not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create trigger composio_auth_configs_set_updated_at
  before update on composio_auth_configs
  for each row execute function set_updated_at();

alter table composio_auth_configs enable row level security;

-- Workspace members can READ (so the settings UI can tell which toolkits are
-- ready to connect without exposing the API key). No member writes; writes
-- happen via service-role from the authorize route.
create policy composio_auth_configs_member_read on composio_auth_configs for select
  using (true);  -- not workspace-scoped; safe to read across all members

-- Seed the row for Gmail since you already created an auth config in the
-- dashboard. Drop this row + restart to let agent-crm create a fresh one
-- via the SDK on the next connect.
insert into composio_auth_configs (toolkit_slug, composio_auth_config_id)
values ('gmail', 'ac_unpO1Tp1weW9')
on conflict (toolkit_slug) do nothing;
