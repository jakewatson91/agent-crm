-- agent-crm v0 fix: explicitly grant execute on the RPC functions PostgREST exposes,
-- and notify PostgREST to reload its schema cache.

grant execute on function record_event(uuid, actor_kind, text, text, target_kind, uuid, jsonb, text, bigint)
  to anon, authenticated, service_role;

grant execute on function replay_to(uuid, timestamptz)
  to anon, authenticated, service_role;

grant execute on function replay_diff(uuid, timestamptz, timestamptz)
  to anon, authenticated, service_role;

grant execute on function match_signal_to_subscriptions(uuid)
  to anon, authenticated, service_role;

grant execute on function query_facts_by_similarity(uuid, vector, integer, text)
  to anon, authenticated, service_role;

grant execute on function compute_fact_hash(uuid, uuid, text, text, uuid)
  to anon, authenticated, service_role;

grant execute on function is_workspace_member(uuid)
  to anon, authenticated, service_role;

-- Tell PostgREST to reload schema (picks up new functions without restart).
notify pgrst, 'reload schema';
