-- agent-crm v0: fact-triggered subscriptions.
--
-- Today subscriptions only match SIGNALS. Once a fact is asserted (e.g.,
-- icp_fit=0.85) nothing fires. This migration adds parallel fact→subscription
-- matching so agents can react to "score crossed threshold" events.
--
-- Backward compatible: existing subscriptions have fact_filter=null and continue
-- to match signals as before. Only subscriptions with a non-null fact_filter
-- participate in fact matching.

alter table subscriptions add column if not exists fact_filter jsonb;

create index if not exists subscriptions_fact_filter_gin
  on subscriptions using gin(fact_filter)
  where active and fact_filter is not null;

------------------------------------------------------------
-- match_fact_to_subscriptions: given a fact_id, find subscriptions whose
-- fact_filter matches.
--
-- fact_filter shape (jsonb):
--   { "predicate": "icp_fit", "operator": "gte"|"lte"|"eq", "value": 0.7 }
-- Operator default is "gte". Numeric facts compared as numeric (cast object_text);
-- non-numeric facts compared as text equality.
------------------------------------------------------------
create or replace function match_fact_to_subscriptions(p_fact_id uuid)
returns table (
  subscription_id uuid,
  owner_kind subscription_owner_kind,
  owner_id text,
  action_on_match text
) as $$
declare
  v_workspace_id uuid;
  v_predicate text;
  v_object_text text;
  v_object_numeric numeric;
begin
  select workspace_id, predicate, object_text
    into v_workspace_id, v_predicate, v_object_text
    from facts where id = p_fact_id and supersedes is null;
  if v_workspace_id is null then return; end if;

  begin v_object_numeric := v_object_text::numeric; exception when others then v_object_numeric := null; end;

  return query
    select s.id, s.owner_kind, s.owner_id, s.action_on_match
      from subscriptions s
     where s.workspace_id = v_workspace_id
       and s.active = true
       and s.fact_filter is not null
       and (s.fact_filter->>'predicate') = v_predicate
       and case
         when (s.fact_filter->>'operator') = 'lte' and v_object_numeric is not null
           then v_object_numeric <= (s.fact_filter->>'value')::numeric
         when (s.fact_filter->>'operator') = 'eq'
           then v_object_text = (s.fact_filter->>'value')
         else  -- default: gte (numeric)
           v_object_numeric is not null and v_object_numeric >= (s.fact_filter->>'value')::numeric
       end;
end;
$$ language plpgsql stable;

grant execute on function match_fact_to_subscriptions(uuid) to authenticated, service_role;

------------------------------------------------------------
-- notify_inngest_fact: AFTER INSERT trigger on facts. Same vault-secret pattern
-- as notify_inngest_signal. Publishes fact.created events to Inngest.
------------------------------------------------------------
create or replace function notify_inngest_fact() returns trigger as $$
declare
  v_endpoint text;
begin
  -- Skip superseded inserts: when a fact is replaced, we get an UPDATE not an INSERT,
  -- but content-hash idempotent re-inserts of identical content shouldn't re-fire.
  -- The existing facts_content_hash_active unique index prevents true duplicates,
  -- so any successful insert is a genuine new fact worth publishing.

  select decrypted_secret into v_endpoint
    from vault.decrypted_secrets
    where name = 'inngest_event_url'
    limit 1;

  if v_endpoint is null or v_endpoint = '' then
    raise warning 'inngest_event_url vault secret not set; fact % will not publish', new.id;
    return new;
  end if;

  perform net.http_post(
    url := v_endpoint,
    body := jsonb_build_object(
      'name', 'fact.created',
      'data', jsonb_build_object(
        'fact_id', new.id,
        'workspace_id', new.workspace_id,
        'subject_entity', new.subject_entity,
        'predicate', new.predicate,
        'object_text', new.object_text,
        'confidence', new.confidence
      )
    ),
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists facts_notify_inngest on facts;
create trigger facts_notify_inngest
  after insert on facts
  for each row execute function notify_inngest_fact();
