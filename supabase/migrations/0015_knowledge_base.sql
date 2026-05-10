-- agent-crm v0: workspace knowledge_base.
-- The mapping layer between what prospects say (their pain in their words) and
-- what we actually solve (our angles, in our words). About = "what we are";
-- Constitution = "how we operate"; KnowledgeBase = "how to translate their pain
-- to our solution." Injected into every agent prompt so drafters/scorers know
-- which angle to lean on for a given signal.

alter table workspaces
  add column knowledge_base text not null default '';
