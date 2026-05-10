-- agent-crm v0: entity-to-entity similarity RPC.
-- Given a source entity, returns the K nearest other entities by cosine distance
-- on their embeddings. Aggregates across perspectives (max similarity wins) so
-- "similar to Acme" finds Acme-likes regardless of which perspective matched.

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
         e.kind::text,
         max(1 - (ee.embedding <=> (select embedding from src)))::numeric as similarity
    from entities e
    join entity_embeddings ee on ee.entity_id = e.id
   where e.workspace_id = p_workspace_id
     and e.id <> p_entity_id
     and (p_perspective is null or ee.perspective = p_perspective)
   group by e.id, e.name, e.kind
   order by similarity desc
   limit p_top_k;
$$ language sql stable;

grant execute on function find_similar_entities(uuid, uuid, integer, text) to authenticated, service_role;
