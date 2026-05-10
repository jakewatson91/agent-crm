-- agent-crm v0: rewrite the Inngest publish triggers to read from Supabase Vault
-- instead of Postgres GUCs. Hosted Supabase blocks ALTER DATABASE SET app.* for
-- the postgres user, so the GUC approach is dead. Vault is the supported path.
--
-- ONE-TIME SETUP (run once in Supabase dashboard SQL editor before this migration
-- is effective). The vault secret name is `inngest_event_url` and stores the
-- full Inngest event ingestion URL with the event key embedded:
--
--   select vault.create_secret(
--     'https://inn.gs/e/REPLACE_WITH_INNGEST_EVENT_KEY',
--     'inngest_event_url'
--   );
--
-- To rotate, update with:
--   select vault.update_secret(id, 'https://inn.gs/e/<NEW_KEY>')
--   from vault.secrets where name = 'inngest_event_url';

create or replace function notify_inngest_signal() returns trigger as $$
declare
  v_endpoint text;
begin
  select decrypted_secret into v_endpoint
    from vault.decrypted_secrets
    where name = 'inngest_event_url'
    limit 1;

  if v_endpoint is null or v_endpoint = '' then
    raise warning 'inngest_event_url vault secret not set; signal % will only publish via recovery cron', new.id;
    return new;
  end if;

  perform net.http_post(
    url := v_endpoint,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'name', 'signal.created',
      'data', jsonb_build_object(
        'signal_id', new.id,
        'workspace_id', new.workspace_id,
        'entity_id', new.entity_id,
        'type', new.type,
        'observed_at', new.observed_at
      )
    )::text
  );
  return new;
end;
$$ language plpgsql security definer;

create or replace function notify_inngest_gate() returns trigger as $$
declare
  v_endpoint text;
begin
  select decrypted_secret into v_endpoint
    from vault.decrypted_secrets
    where name = 'inngest_event_url'
    limit 1;

  if v_endpoint is null or v_endpoint = '' then
    raise warning 'inngest_event_url vault secret not set; gate % will not publish', new.id;
    return new;
  end if;

  perform net.http_post(
    url := v_endpoint,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'name', 'gate.created',
      'data', jsonb_build_object(
        'gate_id', new.id,
        'workspace_id', new.workspace_id,
        'requested_by_agent', new.requested_by_agent,
        'policy', new.policy
      )
    )::text
  );
  return new;
end;
$$ language plpgsql security definer;

-- Triggers themselves are unchanged from migration 0002; the function bodies
-- are what was broken. CREATE OR REPLACE FUNCTION above is enough.
