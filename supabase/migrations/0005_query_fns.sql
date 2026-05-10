-- agent-crm v0 query support
-- Cosine similarity ranking for facts via entity_embeddings, all in SQL so we don't
-- ship vectors over the wire to compute distance client-side.

create or replace function query_facts_by_similarity(
  p_workspace_id    uuid,
  p_query_embedding vector(1536),
  p_top_k           integer default 12,
  p_perspective     text default null
) returns table (
  fact_id        uuid,
  subject_entity uuid,
  predicate      text,
  object_text    text,
  similarity     numeric,
  source_event_id bigint
) as $$
  with ranked_entities as (
    select e.id as entity_id,
           max(1 - (ee.embedding <=> p_query_embedding))::numeric as similarity
      from entities e
      join entity_embeddings ee on ee.entity_id = e.id
     where e.workspace_id = p_workspace_id
       and (p_perspective is null or ee.perspective = p_perspective)
     group by e.id
     order by similarity desc
     limit p_top_k * 4   -- widen so we can find diverse facts per entity
  )
  select f.id,
         f.subject_entity,
         f.predicate,
         f.object_text,
         re.similarity,
         f.source_event_id
    from facts f
    join ranked_entities re on re.entity_id = f.subject_entity
   where f.workspace_id = p_workspace_id
     and f.supersedes is null
   order by re.similarity desc, f.observed_at desc
   limit p_top_k;
$$ language sql stable;

------------------------------------------------------------
-- mark_projection_invalidated: trigger that flags cached projections stale
-- when an event lands that touches an entity referenced in any cached projection.
-- For v0 we use the conservative path: any insert into events invalidates
-- all projection cache rows for the workspace. Future: per-entity invalidation.
------------------------------------------------------------
create or replace function invalidate_projections() returns trigger as $$
begin
  update projections_cache
     set invalidated_by_event = new.id
   where workspace_id = new.workspace_id
     and invalidated_by_event is null;
  return new;
end;
$$ language plpgsql;

create trigger events_invalidate_projections
  after insert on events
  for each row execute function invalidate_projections();
