-- 0039: retention — bound the two tables that grow unbounded.
--
-- (1) signals.embedding becomes nullable so old embeddings can be archived.
--     Live matching only scans recent signals and the embedding is recomputable
--     from body_for_embedding, so once a signal ages past the workspace's TTL we
--     null its vector. The row, body, tags, and extracted facts all stay. The
--     HNSW index simply stops indexing the nulled rows (NULLs aren't indexed),
--     so both the table heap and the index stop growing without bound.
--
-- (2) prune_events(): a controlled, provenance-safe DELETE path. events has
--     UPDATE/DELETE revoked from every role including service_role (0001:293) to
--     keep the log append-only, so the retention job can't delete via PostgREST.
--     This SECURITY DEFINER function (same pattern as record_event) deletes only
--     the operational/telemetry actions the caller whitelists AND never touches
--     an event that a fact points at via source_event_id — so a misconfigured
--     action list still cannot break a fact's provenance chain.

alter table signals alter column embedding drop not null;

create or replace function prune_events(
  p_workspace_id uuid,
  p_actions      text[],
  p_cutoff       timestamptz
) returns integer as $$
declare
  v_deleted integer;
begin
  if p_actions is null or array_length(p_actions, 1) is null then
    return 0;
  end if;

  delete from events e
   where e.workspace_id = p_workspace_id
     and e.action = any(p_actions)
     and e.created_at < p_cutoff
     and not exists (select 1 from facts f where f.source_event_id = e.id);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$ language plpgsql security definer;

grant execute on function prune_events(uuid, text[], timestamptz) to service_role, authenticated;
