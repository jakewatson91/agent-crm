-- Fix query_facts_by_similarity active-fact filter.
--
-- 0005 filtered with `f.supersedes is null`, which returns the STALE original:
-- supersede_fact writes new.supersedes = old.id, so the CURRENT fact is the one
-- NOT pointed at by any other fact's `supersedes`. Same signature and body as
-- 0005; only the active-fact predicate changes, so grants from 0007 persist.

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
     and not exists (
       select 1 from facts s
        where s.workspace_id = p_workspace_id
          and s.supersedes = f.id
     )
   order by re.similarity desc, f.observed_at desc
   limit p_top_k;
$$ language sql stable;
