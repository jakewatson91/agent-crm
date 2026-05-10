-- agent-crm v0: rewrite the Inngest publish triggers to read from Supabase Vault
-- instead of Postgres GUCs. Hosted Supabase blocks ALTER DATABASE SET app.* for
-- the postgres user, so the GUC approach is dead. Vault is the supported path.
--
-- pg_net signature note: net.http_post takes body as jsonb (not text). The
-- original migration 0002 cast body to ::text which would have failed at fire
-- time if the function ever actually ran; it never did because the GUC was
-- unset and the trigger early-returned. Now that vault is populated, body
-- must be passed as jsonb.
--
-- ONE-TIME SETUP (run once via SQL editor or scripts/setup_inngest_publishing.ts):
--   select vault.create_secret(
--     'https://inn.gs/e/REPLACE_WITH_INNGEST_EVENT_KEY',
--     'inngest_event_url'
--   );

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
    body := jsonb_build_object(
      'name', 'signal.created',
      'data', jsonb_build_object(
        'signal_id', new.id,
        'workspace_id', new.workspace_id,
        'entity_id', new.entity_id,
        'type', new.type,
        'observed_at', new.observed_at
      )
    ),
    headers := jsonb_build_object('Content-Type', 'application/json')
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
    body := jsonb_build_object(
      'name', 'gate.created',
      'data', jsonb_build_object(
        'gate_id', new.id,
        'workspace_id', new.workspace_id,
        'requested_by_agent', new.requested_by_agent,
        'policy', new.policy
      )
    ),
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
  return new;
end;
$$ language plpgsql security definer;
