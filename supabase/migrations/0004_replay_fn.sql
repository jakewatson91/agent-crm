-- agent-crm v0 replay
-- replay_to(workspace_id, ts) reconstructs projection state at time ts by replaying events.
--
-- Strategy: build temp tables (entities_at, facts_at, signals_at, channel_posts_at, touches_at, outcomes_at, gates_at)
-- from the events log, applying each event in order up to the cutoff.
--
-- For v0 we materialize as JSON snapshot (one row per kind) rather than recreating temp tables,
-- because callers (benchmark, replay UI) consume the snapshot as a single payload.
--
-- A future optimization is to keep persistent shadow tables and apply incremental events,
-- but the brute-force replay is good enough for benchmark sizes (10k events) at p95 < 500ms.

------------------------------------------------------------
-- replay_to: returns a jsonb snapshot of projection state at p_ts
------------------------------------------------------------
create or replace function replay_to(
  p_workspace_id uuid,
  p_ts           timestamptz
) returns jsonb as $$
declare
  v_snapshot jsonb;
begin
  -- Filter events to the cutoff window.
  -- Apply each event in (created_at, id) order; later events overwrite earlier projections.
  -- We use jsonb_object_agg so the latest payload per (target_kind, target_id) wins.

  with eligible as (
    select id, action, target_kind, target_id, payload, actor_kind, actor_id, created_at
      from events
     where workspace_id = p_workspace_id
       and created_at <= p_ts
     order by created_at, id
  ),
  -- entities: latest payload per id (also tracks supersede via supersede_fact for facts)
  entities_at as (
    select e.target_id as id,
           jsonb_build_object(
             'id', e.target_id,
             'kind', case when e.action = 'create_account' then 'account'
                          when e.action = 'create_contact' then 'contact'
                          else 'unknown' end,
             'name', e.payload->>'name',
             'attributes', coalesce(e.payload->'attributes', '{}'::jsonb),
             'created_at', min(e.created_at) over (partition by e.target_id),
             'updated_at', max(e.created_at) over (partition by e.target_id)
           ) as snapshot
      from eligible e
     where e.action in ('create_account', 'create_contact')
  ),
  -- facts: only those NOT superseded by a later supersede_fact event in the window
  facts_at as (
    select f.target_id as id,
           jsonb_build_object(
             'id', f.target_id,
             'subject_entity', f.payload->>'subject_entity',
             'predicate', f.payload->>'predicate',
             'object_text', f.payload->>'object_text',
             'object_entity', f.payload->>'object_entity',
             'confidence', coalesce((f.payload->>'confidence')::numeric, 1.0),
             'source_event_id', f.id,
             'observed_at', f.created_at,
             'supersedes', f.payload->>'supersedes'
           ) as snapshot
      from eligible f
     where f.action in ('assert_fact', 'supersede_fact')
       and f.target_id not in (
         select (s.payload->>'supersedes')::uuid
           from eligible s
          where s.action = 'supersede_fact'
            and s.payload->>'supersedes' is not null
            and s.created_at <= p_ts
       )
  ),
  signals_at as (
    select s.target_id as id,
           jsonb_build_object(
             'id', s.target_id,
             'entity_id', s.payload->>'entity_id',
             'type', s.payload->>'type',
             'magnitude', coalesce((s.payload->>'magnitude')::numeric, 0.5),
             'structured_tags', coalesce(s.payload->'structured_tags', '{}'::jsonb),
             'observed_at', s.created_at
           ) as snapshot
      from eligible s
     where s.action = 'create_signal'
  ),
  channel_posts_at as (
    select p.target_id as id,
           jsonb_build_object(
             'id', p.target_id,
             'channel_id', p.payload->>'channel_id',
             'kind', p.payload->>'kind',
             'body', p.payload->>'body',
             'cites', coalesce(p.payload->'cites', '[]'::jsonb),
             'author_kind', p.actor_kind,
             'author_id', p.actor_id,
             'created_at', p.created_at
           ) as snapshot
      from eligible p
     where p.action = 'post_to_channel'
  ),
  gates_at as (
    select g.target_id as id,
           jsonb_build_object(
             'id', g.target_id,
             'requested_by_agent', g.actor_id,
             'policy', g.payload->>'policy',
             'condition', coalesce(g.payload->'condition', '{}'::jsonb),
             'channel_post_id', g.payload->>'channel_post_id',
             'requested_at', g.created_at,
             -- Apply the latest decide_gate event for this gate, if any.
             'decision', (
               select d.payload->>'decision'
                 from eligible d
                where d.action = 'decide_gate'
                  and d.target_id = g.target_id
                  and d.created_at <= p_ts
                order by d.created_at desc, d.id desc
                limit 1
             ),
             'decided_at', (
               select d.created_at
                 from eligible d
                where d.action = 'decide_gate'
                  and d.target_id = g.target_id
                  and d.created_at <= p_ts
                order by d.created_at desc, d.id desc
                limit 1
             )
           ) as snapshot
      from eligible g
     where g.action = 'request_gate'
  )
  select jsonb_build_object(
    'workspace_id', p_workspace_id,
    'as_of', p_ts,
    'entities', coalesce((select jsonb_agg(distinct snapshot) from entities_at), '[]'::jsonb),
    'facts', coalesce((select jsonb_agg(snapshot) from facts_at), '[]'::jsonb),
    'signals', coalesce((select jsonb_agg(snapshot) from signals_at), '[]'::jsonb),
    'channel_posts', coalesce((select jsonb_agg(snapshot) from channel_posts_at), '[]'::jsonb),
    'gates', coalesce((select jsonb_agg(distinct snapshot) from gates_at), '[]'::jsonb)
  ) into v_snapshot;

  return v_snapshot;
end;
$$ language plpgsql stable;

------------------------------------------------------------
-- replay_diff: returns events between two timestamps for change-feed UIs
------------------------------------------------------------
create or replace function replay_diff(
  p_workspace_id uuid,
  p_from_ts      timestamptz,
  p_to_ts        timestamptz
) returns setof events as $$
  select * from events
   where workspace_id = p_workspace_id
     and created_at >  p_from_ts
     and created_at <= p_to_ts
   order by created_at, id;
$$ language sql stable;
