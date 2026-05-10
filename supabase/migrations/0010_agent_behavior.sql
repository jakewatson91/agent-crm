-- agent-crm v0: subscription agent behavior.
-- Per-subscription override for what kind of output the agent produces:
--   claim_poster (default) -> post_claim or request_gate, 1-2 sentence claim
--   drafter                 -> touch_draft post with email-shaped body, with pre-LLM suppression/send-cap checks
--
-- Adding a third behavior (e.g. critic) is just a value change here + a branch in runAgent.

alter table subscriptions
  add column agent_behavior text not null default 'claim_poster'
    check (agent_behavior in ('claim_poster', 'drafter'));

-- Existing rows already get the default.
