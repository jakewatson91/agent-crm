-- agent-crm v0: workspace constitution.
-- The global rules of engagement that apply to EVERY agent in the workspace.
-- Free-form prose: voice, what we don't do, hard policies. Agent-specific guidance
-- lives in the subscription's name / semantic_query at creation time, not here.

alter table workspaces
  add column constitution text not null default '';
