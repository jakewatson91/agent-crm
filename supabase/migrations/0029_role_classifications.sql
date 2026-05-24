-- Role-family classifier cache. Maps a job title (+ optional department) to
-- {family, seniority, is_exec}. Used by the ATS connector to decide whether a
-- posting matches the workspace's hiring_filter before creating a signal.
--
-- Globally cached (not per workspace) because titles are vertical-neutral —
-- "Head of Sales" classifies the same way regardless of which workspace asked.
-- A second workspace seeing the same title pays zero LLM cost.
--
-- Title hash is SHA-256 of lower(title) + '|' + lower(department||''), computed
-- in TS before insert. Hash, not raw text, so we don't index a long text column.

create table role_classifications (
  title_hash    text primary key,
  title         text not null,
  department    text,
  family        text not null,        -- 'sales' | 'gtm' | 'engineering' | ... see classify_role.ts
  seniority     text not null,        -- 'ic_junior' | 'ic_mid' | 'lead' | 'manager' | ...
  is_exec       bool not null default false,
  created_at    timestamptz not null default now()
);

alter table role_classifications enable row level security;

-- Deploy-wide cache (no workspace_id). All members can read so the settings UI
-- can show recent classifications if needed. Writes happen via service-role
-- from the ATS connector.
create policy role_classifications_member_read on role_classifications for select
  using (true);
