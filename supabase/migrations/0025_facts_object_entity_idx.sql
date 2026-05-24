-- Index for relatedToEntity lookups (facts where object_entity = X).
-- Partial: ~80% of facts have object_entity = null (firmographic/scoring
-- predicates point at object_text instead). The partial form keeps the
-- index small and the seq-scan fallback cheap when the column is null.
create index if not exists facts_object_entity_idx
  on facts (workspace_id, object_entity)
  where object_entity is not null;
