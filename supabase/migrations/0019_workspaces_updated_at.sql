-- agent-crm v0: workspaces table got created without an updated_at column;
-- every other table has one. Add it + the standard auto-update trigger so the
-- ICP rescore cron can detect when icp/about/constitution changed.

alter table workspaces add column if not exists updated_at timestamptz not null default now();

drop trigger if exists workspaces_set_updated_at on workspaces;
create trigger workspaces_set_updated_at
  before update on workspaces
  for each row execute function set_updated_at();

-- Backfill existing rows so the cron has a baseline. created_at is fine as a proxy.
update workspaces set updated_at = created_at where updated_at is null;
