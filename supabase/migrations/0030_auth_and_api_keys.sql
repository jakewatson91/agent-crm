-- 0030: invitations + API keys + role check on workspace_members.
-- Builds on workspace_members (already exists, used by is_workspace_member()).

------------------------------------------------------------
-- Roles: tighten the existing freeform `role` column.
------------------------------------------------------------
alter table workspace_members
  add constraint workspace_members_role_check
    check (role in ('owner','admin','member','viewer'));

-- Members can already select via existing policy. Add write policies so
-- owners/admins can manage memberships from the API (using user-scoped
-- supabase client). Service-role bypasses RLS, so server can still
-- bootstrap the first owner row on workspace create.
create policy workspace_members_insert on workspace_members
  for insert with check (
    exists (
      select 1 from workspace_members m
      where m.workspace_id = workspace_members.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner','admin')
    )
  );

create policy workspace_members_update on workspace_members
  for update using (
    exists (
      select 1 from workspace_members m
      where m.workspace_id = workspace_members.workspace_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

create policy workspace_members_delete on workspace_members
  for delete using (
    exists (
      select 1 from workspace_members m
      where m.workspace_id = workspace_members.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner','admin')
    )
  );

------------------------------------------------------------
-- workspace_invitations: email + token + role; redeemable once.
------------------------------------------------------------
create table workspace_invitations (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  email         text not null,
  role          text not null check (role in ('admin','member','viewer')),
  token         text not null unique,
  invited_by    uuid not null references auth.users(id),
  expires_at    timestamptz not null default now() + interval '7 days',
  accepted_at   timestamptz,
  accepted_by   uuid references auth.users(id),
  created_at    timestamptz not null default now()
);

create index workspace_invitations_token_pending_idx
  on workspace_invitations(token) where accepted_at is null;
create index workspace_invitations_workspace_idx
  on workspace_invitations(workspace_id);

alter table workspace_invitations enable row level security;

-- Members of the workspace can list/manage their workspace's invites.
create policy workspace_invitations_member_select on workspace_invitations
  for select using (is_workspace_member(workspace_id));

create policy workspace_invitations_admin_write on workspace_invitations
  for all using (
    exists (
      select 1 from workspace_members m
      where m.workspace_id = workspace_invitations.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner','admin')
    )
  );

-- NB: token lookup for /invite/[token] page happens via the service-role
-- server client (no RLS) on the accept route, so we don't need a public
-- by-token select policy here. Keeps tokens out of reach of `anon` reads.

------------------------------------------------------------
-- workspace_api_keys: per-workspace Bearer tokens for /api/mcp.
------------------------------------------------------------
create table workspace_api_keys (
  id            uuid primary key default uuid_generate_v4(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  key_hash      text not null unique,            -- sha256 hex of the secret
  prefix        text not null,                   -- first 12 chars of the secret, for display
  created_by    uuid not null references auth.users(id),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index workspace_api_keys_active_hash_idx
  on workspace_api_keys(key_hash) where revoked_at is null;
create index workspace_api_keys_workspace_idx
  on workspace_api_keys(workspace_id);

alter table workspace_api_keys enable row level security;

-- Members can see keys' metadata (prefix, last-used) but never key_hash.
-- The select policy is on the table; we hide key_hash in the API response.
create policy workspace_api_keys_member_select on workspace_api_keys
  for select using (is_workspace_member(workspace_id));

create policy workspace_api_keys_admin_write on workspace_api_keys
  for all using (
    exists (
      select 1 from workspace_members m
      where m.workspace_id = workspace_api_keys.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner','admin')
    )
  );
