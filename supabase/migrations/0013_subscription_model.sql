-- agent-crm v0: per-subscription model override.
-- Default null = use the runAgent default (gpt-4o-mini). Concrete values:
--   "gpt-4o-mini"                  - OpenAI cheap default
--   "gpt-4o"                       - OpenAI mid-tier
--   "deepseek/deepseek-v4-flash"   - OpenRouter cheap reasoning
--   "deepseek/deepseek-v4-pro"     - OpenRouter higher-tier reasoning
-- Model id with "/" routes to OpenRouter; bare id routes to OpenAI direct.

alter table subscriptions
  add column model text;
