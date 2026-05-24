-- Chat threads persist in conversations(kind='chat'). The intake API loads
-- the most recent row for a workspace, appends each turn, and stamps
-- updated_at so "latest thread" is a cheap indexed lookup.

alter table conversations
  add column if not exists updated_at timestamptz not null default now();

create index if not exists conversations_workspace_kind_recent_idx
  on conversations(workspace_id, kind, updated_at desc);
