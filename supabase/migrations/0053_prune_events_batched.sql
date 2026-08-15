-- 0053: batch prune_events so it can't blow PostgREST's 8s statement_timeout
-- (the authenticator role's session config applies to every RPC call, even
-- after switching to service_role). p_limit defaults to null (unlimited),
-- so existing 3-arg callers are unaffected; runRetention now passes a limit
-- and loops until a batch returns 0.

create or replace function prune_events(
  p_workspace_id uuid,
  p_actions      text[],
  p_cutoff       timestamptz,
  p_limit        integer default null
) returns integer as $$
declare
  v_deleted integer;
begin
  if p_actions is null or array_length(p_actions, 1) is null then
    return 0;
  end if;

  if p_limit is null then
    delete from events e
     where e.workspace_id = p_workspace_id
       and e.action = any(p_actions)
       and e.created_at < p_cutoff
       and not exists (select 1 from facts f where f.source_event_id = e.id);
  else
    delete from events e
     where e.id in (
       select id from events
        where workspace_id = p_workspace_id
          and action = any(p_actions)
          and created_at < p_cutoff
          and not exists (select 1 from facts f where f.source_event_id = events.id)
        limit p_limit
     );
  end if;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$ language plpgsql security definer;

grant execute on function prune_events(uuid, text[], timestamptz, integer) to service_role, authenticated;
