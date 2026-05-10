-- agent-crm v0: workspace About.
-- Free-form prose describing what the company is, what it sells, and how it's different.
-- Constitution is for HOW we communicate (voice, rules); About is for WHAT we do.
-- Both inject into every agent's system prompt.

alter table workspaces
  add column about text not null default '';
