-- agent-crm v0: ingest sources.
-- Symmetric to subscriptions: subscriptions say "when signal X arrives, do Y";
-- sources say "every T, produce signals from origin O."
--
-- Each row is one configured ingest source. The dispatcher cron fetches every
-- active row and runs the connector identified by `connector_type` against the
-- `config` jsonb. Connectors live in code and emit create_signal / create_account
-- via the existing tool surface — same provenance discipline as everything else.

create table sources (
  id              uuid primary key default uuid_generate_v4(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  connector_type  text not null,                       -- 'hn' | 'github' | 'yc' | 'producthunt' | 'rss' | 'web'
  name            text not null,                       -- human label, e.g. 'hn_ai_crm_keywords'
  config          jsonb not null default '{}'::jsonb,  -- per-connector params
  schedule_cron   text not null default '0 * * * *',   -- default hourly
  active          bool not null default true,
  last_run_at     timestamptz,
  last_run_status text,                                -- 'ok' | 'error' | null (never run)
  last_run_summary jsonb,                              -- {signals_created: N, entities_created: M, error?: text}
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index sources_workspace_idx on sources(workspace_id, active);
create index sources_connector_idx on sources(connector_type);
create index sources_schedule_idx on sources(active, last_run_at);

-- updated_at maintenance
create trigger sources_set_updated_at
  before update on sources
  for each row execute function set_updated_at();

-- Service-role only writes; read by workspace members.
alter table sources enable row level security;

create policy sources_member_read on sources for select
  using (
    workspace_id in (
      select workspace_id from workspace_members where user_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE via API; writes go through service-role.
