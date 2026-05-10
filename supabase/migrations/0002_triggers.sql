-- agent-crm v0 triggers and core functions
-- Two big things here:
--   1. record_event(): the only sanctioned way to write. Atomic event + projection upsert.
--   2. notify_inngest(): AFTER INSERT trigger on signals that fires pg_net to Inngest.

------------------------------------------------------------
-- compute_fact_hash: deterministic content hash for a fact
------------------------------------------------------------
create or replace function compute_fact_hash(
  p_workspace_id uuid,
  p_subject_entity uuid,
  p_predicate text,
  p_object_text text,
  p_object_entity uuid
) returns text as $$
  select encode(
    digest(
      p_workspace_id::text || '|' ||
      p_subject_entity::text || '|' ||
      p_predicate || '|' ||
      coalesce(p_object_text, '') || '|' ||
      coalesce(p_object_entity::text, ''),
      'sha256'
    ),
    'hex'
  );
$$ language sql immutable;

------------------------------------------------------------
-- record_event: the single sanctioned write path.
--
-- Inserts one row into events; based on (action, target_kind) also upserts
-- the corresponding projection row(s). Returns the new event id and any
-- newly-allocated target id.
--
-- Action vocabulary mirrors the MCP tool surface:
--   create_workspace, set_workspace_policy
--   create_account, create_contact          -> entities
--   assert_fact, supersede_fact             -> facts
--   create_signal                           -> signals
--   create_subscription                     -> subscriptions
--   post_to_channel                         -> channel_posts (+ channels lazy-created)
--   request_gate, decide_gate               -> gates
--   record_touch, record_outcome            -> touches/outcomes
------------------------------------------------------------
create or replace function record_event(
  p_workspace_id   uuid,
  p_actor_kind     actor_kind,
  p_actor_id       text,
  p_action         text,
  p_target_kind    target_kind,
  p_target_id      uuid,                    -- nullable; allocated when action creates the target
  p_payload        jsonb,
  p_prompt_hash    text default null,
  p_parent_event_id bigint default null
) returns table (event_id bigint, target_id uuid) as $$
declare
  v_event_id        bigint;
  v_target_id       uuid := p_target_id;
  v_channel_id      uuid;
  v_account_id      uuid;
  v_content_hash    text;
  v_existing_fact   uuid;
begin
  -- Lazy-allocate target ids for create operations.
  if v_target_id is null then
    v_target_id := uuid_generate_v4();
  end if;

  -- Insert the event first so projection rows can reference it.
  insert into events (workspace_id, actor_kind, actor_id, action, target_kind, target_id, payload, prompt_hash, parent_event_id)
  values (p_workspace_id, p_actor_kind, p_actor_id, p_action, p_target_kind, v_target_id, p_payload, p_prompt_hash, p_parent_event_id)
  returning id into v_event_id;

  -- Project: per action.
  case p_action
    when 'create_workspace' then
      insert into workspaces (id, name, persona, icp, budget_cents, policy)
      values (
        v_target_id,
        p_payload->>'name',
        coalesce(p_payload->'persona', '{}'::jsonb),
        coalesce(p_payload->'icp', '{}'::jsonb),
        coalesce((p_payload->>'budget_cents')::int, 1000),
        coalesce(p_payload->'policy', '{}'::jsonb)
      );

    when 'set_workspace_policy' then
      update workspaces
         set persona = coalesce(p_payload->'persona', persona),
             icp = coalesce(p_payload->'icp', icp),
             budget_cents = coalesce((p_payload->>'budget_cents')::int, budget_cents),
             policy = coalesce(p_payload->'policy', policy)
       where id = p_workspace_id;

    when 'create_account' then
      insert into entities (id, workspace_id, kind, name, attributes)
      values (v_target_id, p_workspace_id, 'account', p_payload->>'name', coalesce(p_payload->'attributes', '{}'::jsonb));
      -- Auto-create the channel for this account.
      insert into channels (workspace_id, account_entity_id, title)
      values (p_workspace_id, v_target_id, p_payload->>'name')
      on conflict (workspace_id, account_entity_id) do nothing;

    when 'create_contact' then
      insert into entities (id, workspace_id, kind, name, attributes)
      values (v_target_id, p_workspace_id, 'contact', p_payload->>'name', coalesce(p_payload->'attributes', '{}'::jsonb));

    when 'assert_fact' then
      v_content_hash := compute_fact_hash(
        p_workspace_id,
        (p_payload->>'subject_entity')::uuid,
        p_payload->>'predicate',
        p_payload->>'object_text',
        nullif(p_payload->>'object_entity', '')::uuid
      );
      -- Idempotent on hash: if an active fact with this hash exists, return its id.
      select id into v_existing_fact
        from facts
       where workspace_id = p_workspace_id
         and content_hash = v_content_hash
         and supersedes is null
       limit 1;
      if v_existing_fact is not null then
        v_target_id := v_existing_fact;
      else
        insert into facts (id, workspace_id, subject_entity, predicate, object_text, object_entity,
                           source_event_id, confidence, content_hash)
        values (
          v_target_id,
          p_workspace_id,
          (p_payload->>'subject_entity')::uuid,
          p_payload->>'predicate',
          p_payload->>'object_text',
          nullif(p_payload->>'object_entity', '')::uuid,
          v_event_id,
          coalesce((p_payload->>'confidence')::numeric, 1.0),
          v_content_hash
        );
      end if;

    when 'supersede_fact' then
      -- Mark the prior fact superseded; insert the replacement.
      v_content_hash := compute_fact_hash(
        p_workspace_id,
        (p_payload->>'subject_entity')::uuid,
        p_payload->>'predicate',
        p_payload->>'object_text',
        nullif(p_payload->>'object_entity', '')::uuid
      );
      insert into facts (id, workspace_id, subject_entity, predicate, object_text, object_entity,
                         source_event_id, confidence, supersedes, content_hash)
      values (
        v_target_id,
        p_workspace_id,
        (p_payload->>'subject_entity')::uuid,
        p_payload->>'predicate',
        p_payload->>'object_text',
        nullif(p_payload->>'object_entity', '')::uuid,
        v_event_id,
        coalesce((p_payload->>'confidence')::numeric, 1.0),
        (p_payload->>'supersedes')::uuid,
        v_content_hash
      );

    when 'create_signal' then
      insert into signals (id, workspace_id, entity_id, type, magnitude, embedding,
                           source_event_id, structured_tags, body_for_embedding)
      values (
        v_target_id,
        p_workspace_id,
        (p_payload->>'entity_id')::uuid,
        p_payload->>'type',
        coalesce((p_payload->>'magnitude')::numeric, 0.5),
        (p_payload->>'embedding')::vector,
        v_event_id,
        coalesce(p_payload->'structured_tags', '{}'::jsonb),
        p_payload->>'body_for_embedding'
      );

    when 'create_subscription' then
      insert into subscriptions (id, workspace_id, owner_kind, owner_id, name,
                                 semantic_query, semantic_embedding, structured_filter,
                                 threshold, action_on_match, active)
      values (
        v_target_id,
        p_workspace_id,
        (p_payload->>'owner_kind')::subscription_owner_kind,
        p_payload->>'owner_id',
        p_payload->>'name',
        p_payload->>'semantic_query',
        (p_payload->>'semantic_embedding')::vector,
        coalesce(p_payload->'structured_filter', '{}'::jsonb),
        coalesce((p_payload->>'threshold')::numeric, 0.75),
        coalesce(p_payload->>'action_on_match', 'agent.run'),
        coalesce((p_payload->>'active')::boolean, true)
      );

    when 'post_to_channel' then
      v_channel_id := (p_payload->>'channel_id')::uuid;
      insert into channel_posts (id, channel_id, parent_post_id, thread_root_id,
                                 author_kind, author_id, kind, body, cites, source_event_id)
      values (
        v_target_id,
        v_channel_id,
        nullif(p_payload->>'parent_post_id', '')::uuid,
        nullif(p_payload->>'thread_root_id', '')::uuid,
        p_actor_kind,
        p_actor_id,
        (p_payload->>'kind')::post_kind,
        p_payload->>'body',
        coalesce(
          (select array_agg((value)::uuid) from jsonb_array_elements_text(p_payload->'cites')),
          '{}'::uuid[]
        ),
        v_event_id
      );

    when 'request_gate' then
      insert into gates (id, workspace_id, requested_by_agent, channel_post_id,
                         policy, condition, source_event_id)
      values (
        v_target_id,
        p_workspace_id,
        p_actor_id,
        nullif(p_payload->>'channel_post_id', '')::uuid,
        p_payload->>'policy',
        coalesce(p_payload->'condition', '{}'::jsonb),
        v_event_id
      );

    when 'decide_gate' then
      update gates
         set decided_by = p_actor_id::uuid,
             decision = (p_payload->>'decision')::gate_decision,
             decided_at = now()
       where id = v_target_id;

    when 'record_touch' then
      insert into touches (id, workspace_id, contact_entity_id, channel, content,
                           arm_assignments, source_event_id, status)
      values (
        v_target_id,
        p_workspace_id,
        (p_payload->>'contact_entity_id')::uuid,
        coalesce(p_payload->>'channel', 'email'),
        p_payload->>'content',
        coalesce(p_payload->'arm_assignments', '{}'::jsonb),
        v_event_id,
        coalesce((p_payload->>'status')::touch_status, 'queued')
      );

    when 'record_outcome' then
      insert into outcomes (id, touch_id, type, value, source_event_id)
      values (
        v_target_id,
        (p_payload->>'touch_id')::uuid,
        p_payload->>'type',
        coalesce(p_payload->'value', '{}'::jsonb),
        v_event_id
      );

    else
      -- Unknown action: event is recorded but no projection mutation.
      -- This intentionally allows new event types to be appended before code understands them.
      null;
  end case;

  return query select v_event_id, v_target_id;
end;
$$ language plpgsql security definer;

------------------------------------------------------------
-- notify_inngest: AFTER INSERT trigger on signals.
-- Fires pg_net.http_post to the Inngest endpoint (configured via app.inngest_endpoint GUC).
-- Async: does not block the insert.
------------------------------------------------------------
create or replace function notify_inngest_signal() returns trigger as $$
declare
  v_endpoint text;
  v_event_key text;
begin
  -- These are set as Postgres custom GUCs by the app at session start, or via ALTER DATABASE.
  v_endpoint := current_setting('app.inngest_endpoint', true);
  v_event_key := current_setting('app.inngest_event_key', true);
  if v_endpoint is null or v_endpoint = '' then
    return new;  -- silently skip if not configured (e.g. during local migration)
  end if;

  perform net.http_post(
    url := v_endpoint,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Inngest-Event-Key', coalesce(v_event_key, '')
    ),
    body := jsonb_build_object(
      'name', 'signal.created',
      'data', jsonb_build_object(
        'signal_id', new.id,
        'workspace_id', new.workspace_id,
        'entity_id', new.entity_id,
        'type', new.type,
        'observed_at', new.observed_at
      )
    )::text
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger signals_notify_inngest
  after insert on signals
  for each row execute function notify_inngest_signal();

------------------------------------------------------------
-- notify_inngest_gate: same shape, fires on gate insert so the human gets pushed.
------------------------------------------------------------
create or replace function notify_inngest_gate() returns trigger as $$
declare
  v_endpoint text;
  v_event_key text;
begin
  v_endpoint := current_setting('app.inngest_endpoint', true);
  v_event_key := current_setting('app.inngest_event_key', true);
  if v_endpoint is null or v_endpoint = '' then
    return new;
  end if;

  perform net.http_post(
    url := v_endpoint,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Inngest-Event-Key', coalesce(v_event_key, '')
    ),
    body := jsonb_build_object(
      'name', 'gate.created',
      'data', jsonb_build_object(
        'gate_id', new.id,
        'workspace_id', new.workspace_id,
        'requested_by_agent', new.requested_by_agent,
        'policy', new.policy
      )
    )::text
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger gates_notify_inngest
  after insert on gates
  for each row execute function notify_inngest_gate();

------------------------------------------------------------
-- match_signal_to_subscriptions: SQL-level subscription matching.
-- Returns subscription ids whose structured_filter matches the signal's tags
-- AND whose semantic embedding is within threshold cosine of the signal's embedding.
------------------------------------------------------------
create or replace function match_signal_to_subscriptions(p_signal_id uuid)
returns table (subscription_id uuid, owner_kind subscription_owner_kind, owner_id text, action_on_match text, similarity numeric) as $$
  select
    s.id,
    s.owner_kind,
    s.owner_id,
    s.action_on_match,
    (1 - (s.semantic_embedding <=> sig.embedding))::numeric as similarity
  from signals sig
  join subscriptions s
    on s.workspace_id = sig.workspace_id
   and s.active
   and (s.structured_filter = '{}'::jsonb or sig.structured_tags @> s.structured_filter)
  where sig.id = p_signal_id
    and (1 - (s.semantic_embedding <=> sig.embedding)) >= s.threshold
  order by similarity desc;
$$ language sql stable;
