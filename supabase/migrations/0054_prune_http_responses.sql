-- 0054: bound pg_net's internal response log the same way prune_events (0039)
-- bounds events. net._http_response is owned by supabase_admin — service_role
-- has no grant on it, so a SECURITY DEFINER function is the only way to reach
-- it from PostgREST/RPC (same reasoning as prune_events).
--
-- This is not app data and not workspace-scoped: it's pg_net's log of async
-- HTTP calls, used briefly to correlate a request with its response. There is
-- no built-in cleanup for it, and it was found holding ~46MB of dead rows
-- against ~500 live ones (2026-08-14). A 1-day cutoff is generous headroom
-- over how long anything actually needs to read a row before it's stale.
--
-- DELETE can run through PostgREST; the VACUUM that actually shrinks the file
-- afterward cannot (VACUUM is a top-level-only command, same restriction that
-- already keeps the HNSW reindex out of Inngest and confined to the launchd
-- loop's direct connection) — see pruneHttpResponses / the loop's vacuum step.

create or replace function prune_http_responses(
  p_cutoff timestamptz,
  p_limit  integer default null
) returns integer as $$
declare
  v_deleted integer;
begin
  if p_limit is null then
    delete from net._http_response where created < p_cutoff;
  else
    delete from net._http_response
     where id in (select id from net._http_response where created < p_cutoff limit p_limit);
  end if;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$ language plpgsql security definer;

grant execute on function prune_http_responses(timestamptz, integer) to service_role;
