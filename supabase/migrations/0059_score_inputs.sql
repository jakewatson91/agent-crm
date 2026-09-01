-- Everything scoreEntity reads about one entity, in a single round trip.
--
-- Scoring was the largest source of Supabase requests on the project: nine to
-- twelve separate PostgREST calls per entity (the entity row, its facts, two
-- graph edge directions, a superseded-check per direction, the neighbours'
-- icp_fit, the works_at contacts, then those contacts' facts and names). At
-- ~3,010 entities scored a day that is ~27,000 of the ~33,000 daily requests,
-- and on the free tier egress is billed per request far more than per byte.
--
-- This is a transport change only. Every filter, direction and ordering below
-- is a literal translation of what packages/tools/src/scoring.ts and
-- packages/tools/src/graph.ts already issued, so the bundle must be identical
-- to what the client assembled itself. Two rules that are easy to get wrong:
--
--   * `facts` and `subject_facts` are returned RAW, superseded rows included.
--     scoreEntity filters them itself, against the fetched set, and changing
--     that here would change which facts reach the rubric.
--   * the graph arrays ARE filtered, because excludeSuperseded() filtered them
--     on the client. "Superseded" means some other fact in this workspace
--     points at this row via `supersedes` — not that this row's own supersedes
--     column is set, which reads the ORIGINAL and would drop live facts.

create or replace function public.score_inputs(p_workspace uuid, p_entity uuid)
returns jsonb
language sql
stable
as $$
with
-- graph edges, this entity as subject (any fact pointing at another entity)
subj_edges as (
  select f.id, f.predicate, f.object_entity
  from facts f
  where f.workspace_id = p_workspace
    and f.subject_entity = p_entity
    and f.object_entity is not null
    and not exists (select 1 from facts s where s.workspace_id = p_workspace and s.supersedes = f.id)
),
-- graph edges, this entity as object
obj_edges as (
  select f.id, f.predicate, f.subject_entity
  from facts f
  where f.workspace_id = p_workspace
    and f.object_entity = p_entity
    and not exists (select 1 from facts s where s.workspace_id = p_workspace and s.supersedes = f.id)
),
-- the client walked subject edges first, then object edges, keeping the first
-- edge seen per neighbour. Only the neighbour id set matters for the icp_fit
-- lookup, so a plain union is faithful here.
neighbours as (
  select object_entity as id from subj_edges
  union
  select subject_entity as id from obj_edges
),
fits as (
  select f.id, f.subject_entity, f.object_text
  from facts f
  where f.workspace_id = p_workspace
    and f.predicate = 'icp_fit'
    and f.subject_entity in (select id from neighbours)
    and not exists (select 1 from facts s where s.workspace_id = p_workspace and s.supersedes = f.id)
),
-- contacts linked to this account. supersedes IS NULL here matches the client
-- query exactly; it is the one place the original code used that filter.
contacts as (
  select f.subject_entity as id
  from facts f
  where f.workspace_id = p_workspace
    and f.predicate = 'works_at'
    and f.object_entity = p_entity
    and f.supersedes is null
)
select jsonb_build_object(
  'entity', (
    select to_jsonb(e) from (select id, name, attributes from entities where id = p_entity) e
  ),
  'facts', coalesce((
    select jsonb_agg(to_jsonb(f) order by f.observed_at desc) from (
      select id, predicate, object_text, confidence, observed_at, created_at, supersedes, signal_id
      from facts
      where workspace_id = p_workspace and subject_entity = p_entity
    ) f
  ), '[]'::jsonb),
  'subj_edges', coalesce((select jsonb_agg(to_jsonb(x)) from subj_edges x), '[]'::jsonb),
  'obj_edges',  coalesce((select jsonb_agg(to_jsonb(x)) from obj_edges x),  '[]'::jsonb),
  'fits',       coalesce((select jsonb_agg(to_jsonb(x)) from fits x),       '[]'::jsonb),
  'contact_ids', coalesce((select jsonb_agg(id) from contacts), '[]'::jsonb),
  'contact_facts', coalesce((
    select jsonb_agg(to_jsonb(f)) from (
      select id, subject_entity, predicate, object_text, observed_at, supersedes
      from facts
      where workspace_id = p_workspace and subject_entity in (select id from contacts)
    ) f
  ), '[]'::jsonb),
  'contact_names', coalesce((
    select jsonb_agg(to_jsonb(e)) from (
      select id, name from entities where id in (select id from contacts)
    ) e
  ), '[]'::jsonb)
);
$$;

revoke all on function public.score_inputs(uuid, uuid) from public, anon;
grant execute on function public.score_inputs(uuid, uuid) to service_role;

-- The superseded checks above probe facts by (workspace_id, supersedes) once
-- per candidate row. 0048 indexed supersedes; this makes the probe workspace
-- local so a busy workspace does not scan another's history.
create index if not exists facts_ws_supersedes_idx on facts (workspace_id, supersedes) where supersedes is not null;
