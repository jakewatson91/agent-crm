-- agent-crm v0: extend entity kinds + enricher agent behavior.
--
-- Three new entity kinds (opportunity / interaction / organization) — all optional,
-- not every workspace uses them. attributes jsonb carries the per-kind shape.
--
-- enricher = third agent_behavior. Reads a signal + its entity, extracts atomic facts,
-- calls assert_fact for each. Closes the citation loop so entities accumulate ground
-- truth over time instead of just signal history.

-- Postgres requires ALTER TYPE ADD VALUE outside a transaction. supabase db push
-- handles that.
alter type entity_kind add value if not exists 'opportunity';
alter type entity_kind add value if not exists 'interaction';
alter type entity_kind add value if not exists 'organization';

-- Drop and re-add the agent_behavior check to include 'enricher'.
alter table subscriptions drop constraint if exists subscriptions_agent_behavior_check;
alter table subscriptions add constraint subscriptions_agent_behavior_check
  check (agent_behavior in ('claim_poster', 'drafter', 'enricher'));
