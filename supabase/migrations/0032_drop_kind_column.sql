-- 0032: drop entities.kind column and the entity_kind enum.
--
-- 0031 backfilled `(entity, is_a, <kind>)` facts for every entity and made
-- record_event write the is_a fact atomically with the entity row. All
-- production read paths have since moved off the column (see plan in
-- enumerated-foraging-spindle.md, Phase 2). This migration:
--
--   1. Rewrites record_event() so create_account / create_contact no longer
--      insert into entities.kind. The is_a fact insertion stays.
--   2. Rewrites the find_similar_entities RPC to read the entity's primary
--      type from facts instead of the dropped column.
--   3. Drops entities.kind and the entity_kind enum.
--   4. Recreates entities_workspace_idx without the kind component.

------------------------------------------------------------
-- 1) record_event() — same body as 0031 minus the kind writes.
------------------------------------------------------------
create or replace function record_event(
  p_workspace_id    uuid,
  p_actor_kind      actor_kind,
  p_actor_id        text,
  p_action          text,
  p_target_kind     target_kind,
  p_target_id       uuid,
  p_payload         jsonb,
  p_prompt_hash     text default null,
  p_parent_event_id bigint default null
) returns table (event_id bigint, target_id uuid) as $$
declare
  v_event_id        bigint;
  v_target_id       uuid := p_target_id;
  v_workspace_id    uuid := p_workspace_id;
  v_content_hash    text;
  v_existing_fact   uuid;
  v_is_a_value      text;
begin
  if v_target_id is null then
    v_target_id := uuid_generate_v4();
  end if;

  if p_action = 'create_workspace' then
    v_workspace_id := v_target_id;
    insert into workspaces (id, name, persona, icp, budget_cents, policy)
    values (
      v_target_id,
      p_payload->>'name',
      coalesce(p_payload->'persona', '{}'::jsonb),
      coalesce(p_payload->'icp', '{}'::jsonb),
      coalesce((p_payload->>'budget_cents')::int, 1000),
      coalesce(p_payload->'policy', '{}'::jsonb)
    );
  end if;

  insert into events (workspace_id, actor_kind, actor_id, action, target_kind, target_id, payload, prompt_hash, parent_event_id)
  values (v_workspace_id, p_actor_kind, p_actor_id, p_action, p_target_kind, v_target_id, p_payload, p_prompt_hash, p_parent_event_id)
  returning id into v_event_id;

  case p_action
    when 'create_workspace' then
      null;

    when 'set_workspace_policy' then
      update workspaces
         set persona = coalesce(p_payload->'persona', persona),
             icp = coalesce(p_payload->'icp', icp),
             budget_cents = coalesce((p_payload->>'budget_cents')::int, budget_cents),
             policy = coalesce(p_payload->'policy', policy)
       where id = v_workspace_id;

    when 'create_account' then
      insert into entities (id, workspace_id, name, attributes)
      values (v_target_id, v_workspace_id, p_payload->>'name', coalesce(p_payload->'attributes', '{}'::jsonb));
      insert into channels (workspace_id, account_entity_id, title)
      values (v_workspace_id, v_target_id, p_payload->>'name')
      on conflict (workspace_id, account_entity_id) do nothing;
      v_is_a_value := 'account';
      v_content_hash := compute_fact_hash(v_workspace_id, v_target_id, 'is_a', v_is_a_value, null);
      insert into facts (workspace_id, subject_entity, predicate, object_text, source_event_id, confidence, content_hash)
      values (v_workspace_id, v_target_id, 'is_a', v_is_a_value, v_event_id, 1.0, v_content_hash)
      on conflict do nothing;

    when 'create_contact' then
      insert into entities (id, workspace_id, name, attributes)
      values (v_target_id, v_workspace_id, p_payload->>'name', coalesce(p_payload->'attributes', '{}'::jsonb));
      v_is_a_value := 'contact';
      v_content_hash := compute_fact_hash(v_workspace_id, v_target_id, 'is_a', v_is_a_value, null);
      insert into facts (workspace_id, subject_entity, predicate, object_text, source_event_id, confidence, content_hash)
      values (v_workspace_id, v_target_id, 'is_a', v_is_a_value, v_event_id, 1.0, v_content_hash)
      on conflict do nothing;

    when 'assert_fact' then
      v_content_hash := compute_fact_hash(
        v_workspace_id,
        (p_payload->>'subject_entity')::uuid,
        p_payload->>'predicate',
        p_payload->>'object_text',
        nullif(p_payload->>'object_entity', '')::uuid
      );
      select id into v_existing_fact
        from facts
       where workspace_id = v_workspace_id
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
          v_workspace_id,
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
      v_content_hash := compute_fact_hash(
        v_workspace_id,
        (p_payload->>'subject_entity')::uuid,
        p_payload->>'predicate',
        p_payload->>'object_text',
        nullif(p_payload->>'object_entity', '')::uuid
      );
      insert into facts (id, workspace_id, subject_entity, predicate, object_text, object_entity,
                         source_event_id, confidence, supersedes, content_hash)
      values (
        v_target_id,
        v_workspace_id,
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
        v_workspace_id,
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
        v_workspace_id,
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
      insert into channel_posts (id, channel_id, parent_post_id, thread_root_id,
                                 author_kind, author_id, kind, body, cites, source_event_id)
      values (
        v_target_id,
        (p_payload->>'channel_id')::uuid,
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
        v_workspace_id,
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
        v_workspace_id,
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
      null;
  end case;

  return query select v_event_id, v_target_id;
end;
$$ language plpgsql security definer;

grant execute on function record_event(uuid, actor_kind, text, text, target_kind, uuid, jsonb, text, bigint)
  to anon, authenticated, service_role;

------------------------------------------------------------
-- 2) find_similar_entities RPC — read type from facts instead of e.kind.
------------------------------------------------------------
create or replace function find_similar_entities(
  p_workspace_id   uuid,
  p_entity_id      uuid,
  p_top_k          integer default 8,
  p_perspective    text default null
) returns table (
  entity_id  uuid,
  name       text,
  kind       text,
  similarity numeric
) as $$
  with src as (
    select ee.embedding, ee.perspective
      from entity_embeddings ee
      join entities e on e.id = ee.entity_id
     where e.workspace_id = p_workspace_id
       and ee.entity_id = p_entity_id
       and (p_perspective is null or ee.perspective = p_perspective)
     limit 1
  )
  select e.id,
         e.name,
         coalesce(
           (select f.object_text
              from facts f
             where f.subject_entity = e.id
               and f.predicate = 'is_a'
               and f.supersedes is null
             limit 1),
           'entity'
         ) as kind,
         max(1 - (ee.embedding <=> (select embedding from src)))::numeric as similarity
    from entities e
    join entity_embeddings ee on ee.entity_id = e.id
   where e.workspace_id = p_workspace_id
     and e.id <> p_entity_id
     and (p_perspective is null or ee.perspective = p_perspective)
   group by e.id, e.name
   order by similarity desc
   limit p_top_k;
$$ language sql stable;

grant execute on function find_similar_entities(uuid, uuid, integer, text) to authenticated, service_role;

------------------------------------------------------------
-- 3) Drop the column and the enum.
------------------------------------------------------------
drop index if exists entities_workspace_idx;
alter table entities drop column kind;
drop type entity_kind;

------------------------------------------------------------
-- 4) Recreate the workspace index without the kind component.
------------------------------------------------------------
create index entities_workspace_idx on entities (workspace_id);

notify pgrst, 'reload schema';
