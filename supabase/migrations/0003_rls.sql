-- agent-crm v0 row-level security
-- Default deny. Members of a workspace see/write that workspace's data.
-- service_role bypasses RLS (used by server-side primitives package).

------------------------------------------------------------
-- Helper: current user is a member of workspace?
------------------------------------------------------------
create or replace function is_workspace_member(p_workspace_id uuid)
returns boolean as $$
  select exists (
    select 1 from workspace_members
    where workspace_id = p_workspace_id and user_id = auth.uid()
  );
$$ language sql stable security definer;

------------------------------------------------------------
-- Enable RLS on every workspace-scoped table
------------------------------------------------------------
alter table workspaces           enable row level security;
alter table workspace_members    enable row level security;
alter table entities             enable row level security;
alter table entity_embeddings    enable row level security;
alter table events               enable row level security;
alter table facts                enable row level security;
alter table signals              enable row level security;
alter table subscriptions        enable row level security;
alter table channels             enable row level security;
alter table channel_posts        enable row level security;
alter table touches              enable row level security;
alter table outcomes             enable row level security;
alter table gates                enable row level security;
alter table conversations        enable row level security;
alter table projections_cache    enable row level security;

------------------------------------------------------------
-- workspaces
------------------------------------------------------------
create policy workspaces_select on workspaces
  for select using (is_workspace_member(id));

create policy workspaces_insert on workspaces
  for insert with check (true);  -- new workspace creation is bootstrapped server-side

------------------------------------------------------------
-- workspace_members
------------------------------------------------------------
create policy workspace_members_select on workspace_members
  for select using (user_id = auth.uid() or is_workspace_member(workspace_id));

------------------------------------------------------------
-- entities + embeddings
------------------------------------------------------------
create policy entities_select on entities
  for select using (is_workspace_member(workspace_id));

create policy entity_embeddings_select on entity_embeddings
  for select using (
    exists (select 1 from entities e where e.id = entity_embeddings.entity_id and is_workspace_member(e.workspace_id))
  );

------------------------------------------------------------
-- events: select-only for members; writes go through record_event() as service_role
------------------------------------------------------------
create policy events_select on events
  for select using (is_workspace_member(workspace_id));

------------------------------------------------------------
-- facts
------------------------------------------------------------
create policy facts_select on facts
  for select using (is_workspace_member(workspace_id));

------------------------------------------------------------
-- signals
------------------------------------------------------------
create policy signals_select on signals
  for select using (is_workspace_member(workspace_id));

------------------------------------------------------------
-- subscriptions: members see all in their workspace; can create/edit their own
------------------------------------------------------------
create policy subscriptions_select on subscriptions
  for select using (is_workspace_member(workspace_id));

create policy subscriptions_insert on subscriptions
  for insert with check (
    is_workspace_member(workspace_id)
    and (owner_kind = 'agent' or (owner_kind = 'user' and owner_id = auth.uid()::text))
  );

create policy subscriptions_update on subscriptions
  for update using (
    is_workspace_member(workspace_id)
    and (owner_kind = 'agent' or owner_id = auth.uid()::text)
  );

------------------------------------------------------------
-- channels + channel_posts
------------------------------------------------------------
create policy channels_select on channels
  for select using (is_workspace_member(workspace_id));

create policy channel_posts_select on channel_posts
  for select using (
    exists (select 1 from channels c where c.id = channel_posts.channel_id and is_workspace_member(c.workspace_id))
  );

------------------------------------------------------------
-- touches + outcomes
------------------------------------------------------------
create policy touches_select on touches
  for select using (is_workspace_member(workspace_id));

create policy outcomes_select on outcomes
  for select using (
    exists (select 1 from touches t where t.id = outcomes.touch_id and is_workspace_member(t.workspace_id))
  );

------------------------------------------------------------
-- gates: members see; only members can decide
------------------------------------------------------------
create policy gates_select on gates
  for select using (is_workspace_member(workspace_id));

create policy gates_decide on gates
  for update using (is_workspace_member(workspace_id));

------------------------------------------------------------
-- conversations
------------------------------------------------------------
create policy conversations_select on conversations
  for select using (is_workspace_member(workspace_id));

------------------------------------------------------------
-- projections_cache
------------------------------------------------------------
create policy projections_cache_select on projections_cache
  for select using (is_workspace_member(workspace_id));
