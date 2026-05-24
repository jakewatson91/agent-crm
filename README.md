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

## Self-host

You bring a Supabase Cloud project (free tier is enough — Postgres + Auth + RLS
in one) and run the web app yourself.

```bash
# 1. Create a Supabase Cloud project at supabase.com — copy URL + anon key + service role key.
# 2. Apply migrations (one of):
#    - supabase link --project-ref <ref> && supabase db push
#    - or: pnpm exec tsx scripts/apply_migration.ts supabase/migrations/0001_init.sql  # repeat for each
# 3. Configure env:
cp .env.example .env
# Fill in NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
# SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY at minimum.
# Inngest and Resend are optional; the app degrades gracefully without them.

# 4. Run via Docker:
docker compose up --build
# → web at localhost:3000, inngest dev UI at localhost:8288
```

Sign in on the home page with a magic link (Supabase Auth emails it). The
first signed-in user creating a workspace becomes its owner. To onboard
teammates, go to Settings → Members and invite them by email.

For external agents / scripts, issue a key in Settings → API keys, then call:

```bash
curl -H "Authorization: Bearer acrm_..." \
     -H "Content-Type: application/json" \
     -d '{"method":"tools/list"}' \
     http://localhost:3000/api/mcp
```

### Bootstrapping owners on an existing single-tenant deployment

If you applied the auth migration on a project that had workspaces from the
pre-auth era, those workspaces have no `workspace_members` rows and will not
be visible after sign-in. Run once:

```bash
pnpm exec tsx scripts/bootstrap_owner.ts you@example.com
```

This assigns `role='owner'` to that user for every workspace they don't
already belong to.

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
