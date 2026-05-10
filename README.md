# agent-crm

Agent-first CRM. The agent is the primary user; humans intervene at exception gates only.

See:
- `CLAUDE.md` for project context
- `architecture/` for entity model and abstraction layer
- `brainstorm/` for product thesis
- `/Users/jakewatson/.claude/plans/happy-puzzling-pearl.md` for the v0 build plan

## v0 setup

```bash
pnpm install
cp .env.example .env.local   # fill in Supabase, Inngest, Anthropic, OpenAI keys
pnpm db:migrate              # run Supabase migrations
pnpm dev                     # start Next.js + local Inngest dev server
```

## Layout

- `apps/web/` — Next.js 15 viewer UI
- `packages/primitives/` — the 5 primitives (subscribe, act, gate, query, cite)
- `packages/tools/` — 13 MCP tools, each emits one event
- `packages/agents/` — subscription bundles + prompts (lightweight v0 set)
- `packages/db/` — Supabase client + generated types
- `supabase/migrations/` — schema, triggers, RLS, replay function
- `inngest/functions/` — durable agent runtime
- `workers/ingest/` — Python (uv) workers for free-API discovery
- `benchmark/` — head-to-head vs HubSpot baseline (the proof)

## What we are proving

Six falsifiable claims vs HubSpot baseline. See `benchmark/workloads/` and `BENCHMARK.md` (generated).
