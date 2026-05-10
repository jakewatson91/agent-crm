-- agent-crm v0 schema
-- All tables are workspace-scoped. Events are the source of truth; everything else is a projection.

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists pg_net;
create extension if not exists pg_trgm;

------------------------------------------------------------
-- workspaces (top-level tenant)
------------------------------------------------------------
create table workspaces (
  id              uuid primary key default uuid_generate_v4(),
  name            text not null,
  persona         jsonb not null default '{}'::jsonb,
  icp             jsonb not null default '{}'::jsonb,
  budget_cents    integer not null default 1000,    -- daily ceiling, default $10
  policy          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

------------------------------------------------------------
-- workspace_members (multi-tenant link to auth.users)
------------------------------------------------------------
create table workspace_members (
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            text not null default 'member',   -- owner | member | viewer
  created_at      timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

------------------------------------------------------------
-- entities (accounts, contacts, products)
------------------------------------------------------------
create type entity_kind as enum ('account', 'contact', 'product');

create table entities (
  id              uuid primary key default uuid_generate_v4(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  kind            entity_kind not null,
  name            text not null,
  attributes      jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index entities_workspace_idx on entities(workspace_id, kind);
create index entities_attrs_gin on entities using gin(attributes);
create index entities_name_trgm on entities using gin(name gin_trgm_ops);

------------------------------------------------------------
-- entity_embeddings (multi-perspective per entity-model.md)
------------------------------------------------------------
create table entity_embeddings (
  entity_id       uuid not null references entities(id) on delete cascade,
  perspective     text not null,                    -- 'stack' | 'pain' | 'seniority' | 'vertical' | 'default'
  embedding       vector(1536) not null,
  computed_at     timestamptz not null default now(),
  primary key (entity_id, perspective)
);

create index entity_embeddings_hnsw on entity_embeddings using hnsw (embedding vector_cosine_ops);

------------------------------------------------------------
-- events (append-only, source of truth)
-- UPDATE/DELETE grants revoked at end of file.
------------------------------------------------------------
create type actor_kind as enum ('agent', 'user', 'system');
create type target_kind as enum ('entity', 'fact', 'signal', 'subscription', 'channel', 'channel_post', 'touch', 'gate', 'workspace', 'conversation', 'outcome');

create table events (
  id                bigserial primary key,
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  actor_kind        actor_kind not null,
  actor_id          text not null,                  -- agent name or user uuid
  action            text not null,                  -- 'assert_fact', 'create_signal', etc.
  target_kind       target_kind not null,
  target_id         uuid,                           -- nullable for create operations that allocate ids
  payload           jsonb not null default '{}'::jsonb,
  prompt_hash       text,                           -- sha256 of prompt that generated this event
  parent_event_id   bigint references events(id),   -- causal chain
  created_at        timestamptz not null default now()
);

create index events_workspace_time_idx on events(workspace_id, created_at desc);
create index events_target_idx on events(target_kind, target_id);
create index events_action_idx on events(workspace_id, action);
create index events_payload_gin on events using gin(payload);

------------------------------------------------------------
-- facts (atomic claims, content-addressed)
------------------------------------------------------------
create table facts (
  id                uuid primary key default uuid_generate_v4(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  subject_entity    uuid not null references entities(id) on delete cascade,
  predicate         text not null,
  object_text       text,
  object_entity     uuid references entities(id) on delete set null,
  source_event_id   bigint not null references events(id),
  confidence        numeric not null default 1.0 check (confidence >= 0 and confidence <= 1),
  observed_at       timestamptz not null default now(),
  supersedes        uuid references facts(id),
  content_hash      text not null,                  -- sha256(workspace||subject||predicate||object)
  created_at        timestamptz not null default now()
);

create unique index facts_content_hash_active
  on facts(workspace_id, content_hash)
  where supersedes is null;

create index facts_subject_idx on facts(workspace_id, subject_entity, predicate);
create index facts_predicate_idx on facts(workspace_id, predicate);
create index facts_source_event_idx on facts(source_event_id);

------------------------------------------------------------
-- signals (typed observations, embedding-ready)
------------------------------------------------------------
create table signals (
  id                uuid primary key default uuid_generate_v4(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  entity_id         uuid not null references entities(id) on delete cascade,
  type              text not null,                  -- 'job_post' | 'github_star' | 'hn_mention' | etc.
  magnitude         numeric not null default 0.5 check (magnitude >= 0 and magnitude <= 1),
  embedding         vector(1536) not null,
  source_event_id   bigint not null references events(id),
  observed_at       timestamptz not null default now(),
  structured_tags   jsonb not null default '{}'::jsonb,
  body_for_embedding text,                          -- raw text used to compute embedding
  created_at        timestamptz not null default now()
);

create index signals_workspace_time_idx on signals(workspace_id, observed_at desc);
create index signals_entity_idx on signals(workspace_id, entity_id);
create index signals_type_idx on signals(workspace_id, type);
create index signals_tags_gin on signals using gin(structured_tags);
create index signals_embedding_hnsw on signals using hnsw (embedding vector_cosine_ops);

------------------------------------------------------------
-- subscriptions (forever-running predicate filters)
------------------------------------------------------------
create type subscription_owner_kind as enum ('agent', 'user');

create table subscriptions (
  id                  uuid primary key default uuid_generate_v4(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  owner_kind          subscription_owner_kind not null,
  owner_id            text not null,                -- agent name or user uuid
  name                text not null,
  semantic_query      text not null,
  semantic_embedding  vector(1536) not null,
  structured_filter   jsonb not null default '{}'::jsonb,
  threshold           numeric not null default 0.75 check (threshold >= 0 and threshold <= 1),
  action_on_match     text not null default 'agent.run',  -- 'agent.run' | 'channel.post' | 'webhook'
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);

create index subscriptions_workspace_active_idx on subscriptions(workspace_id) where active;
create index subscriptions_filter_gin on subscriptions using gin(structured_filter);
create index subscriptions_embedding_hnsw on subscriptions using hnsw (semantic_embedding vector_cosine_ops);

------------------------------------------------------------
-- channels (per-account channel = projection of subscription matches)
------------------------------------------------------------
create table channels (
  id                uuid primary key default uuid_generate_v4(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  account_entity_id uuid not null references entities(id) on delete cascade,
  title             text not null,
  created_at        timestamptz not null default now(),
  unique (workspace_id, account_entity_id)
);

------------------------------------------------------------
-- channel_posts (the UI surface; one post per agent meaningful action)
------------------------------------------------------------
create type post_kind as enum ('claim', 'question', 'decision', 'touch_draft', 'gate_request', 'system', 'outcome');

create table channel_posts (
  id                uuid primary key default uuid_generate_v4(),
  channel_id        uuid not null references channels(id) on delete cascade,
  thread_root_id    uuid references channel_posts(id),
  parent_post_id    uuid references channel_posts(id),
  author_kind       actor_kind not null,
  author_id         text not null,
  kind              post_kind not null,
  body              text not null,
  cites             uuid[] not null default '{}'::uuid[],   -- fact ids
  source_event_id   bigint references events(id),
  created_at        timestamptz not null default now()
);

create index channel_posts_channel_time_idx on channel_posts(channel_id, created_at desc);
create index channel_posts_thread_idx on channel_posts(thread_root_id);
create index channel_posts_parent_idx on channel_posts(parent_post_id);

------------------------------------------------------------
-- touches (outbound actions; deferred surface but schema present)
------------------------------------------------------------
create type touch_status as enum ('queued', 'sent', 'bounced', 'replied', 'unsubscribed');

create table touches (
  id                uuid primary key default uuid_generate_v4(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  contact_entity_id uuid not null references entities(id) on delete cascade,
  channel           text not null,                  -- 'email' | 'other'
  content           text not null,
  message_id        text,
  arm_assignments   jsonb not null default '{}'::jsonb,
  source_event_id   bigint not null references events(id),
  status            touch_status not null default 'queued',
  sent_at           timestamptz,
  created_at        timestamptz not null default now()
);

create index touches_workspace_idx on touches(workspace_id, status);
create index touches_contact_idx on touches(contact_entity_id);

------------------------------------------------------------
-- outcomes (observed result of a touch; grounds the feedback loop)
------------------------------------------------------------
create table outcomes (
  id                uuid primary key default uuid_generate_v4(),
  touch_id          uuid not null references touches(id) on delete cascade,
  type              text not null,                  -- 'reply_pos' | 'reply_neg' | 'booked' | 'opened' | 'bounced' | 'unsubscribed'
  value             jsonb not null default '{}'::jsonb,
  source_event_id   bigint not null references events(id),
  observed_at       timestamptz not null default now()
);

create index outcomes_touch_idx on outcomes(touch_id);

------------------------------------------------------------
-- gates (the only place humans MUST intervene)
------------------------------------------------------------
create type gate_decision as enum ('approve', 'reject', 'modify');

create table gates (
  id                  uuid primary key default uuid_generate_v4(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  requested_by_agent  text not null,
  channel_post_id     uuid references channel_posts(id),
  policy              text not null,
  condition           jsonb not null default '{}'::jsonb,
  source_event_id     bigint not null references events(id),
  requested_at        timestamptz not null default now(),
  decided_by          uuid references auth.users(id),
  decision            gate_decision,
  decided_at          timestamptz
);

create index gates_workspace_pending_idx on gates(workspace_id) where decided_at is null;

------------------------------------------------------------
-- conversations (call/email threads with extracted facts)
------------------------------------------------------------
create type conversation_kind as enum ('email_thread', 'call', 'chat');

create table conversations (
  id                  uuid primary key default uuid_generate_v4(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  kind                conversation_kind not null,
  transcript          jsonb not null default '{}'::jsonb,
  audio_storage_path  text,
  extracted_facts     uuid[] not null default '{}'::uuid[],
  source_event_id     bigint references events(id),
  created_at          timestamptz not null default now()
);

create index conversations_workspace_idx on conversations(workspace_id);

------------------------------------------------------------
-- projections_cache (per-(asker, query) cached answer with cites)
------------------------------------------------------------
create table projections_cache (
  key                     text primary key,         -- hash(workspace_id, asker, query, perspective)
  workspace_id            uuid not null references workspaces(id) on delete cascade,
  value                   jsonb not null,
  computed_at             timestamptz not null default now(),
  invalidated_by_event    bigint                    -- first event after computed_at that touched a referenced entity
);

create index projections_cache_workspace_idx on projections_cache(workspace_id);
create index projections_cache_invalidated_idx on projections_cache(workspace_id, invalidated_by_event)
  where invalidated_by_event is null;

------------------------------------------------------------
-- Enforce events append-only at the SQL level.
------------------------------------------------------------
revoke update, delete on events from public, anon, authenticated, service_role;
-- Note: service_role can still insert, which is what we want.

------------------------------------------------------------
-- Updated_at trigger for entities
------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger entities_updated_at
  before update on entities
  for each row execute function set_updated_at();
