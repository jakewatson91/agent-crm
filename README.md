# agent-crm

Agent-first CRM. The agent is the primary user. A person is asked only to approve
the one step that cannot be taken back: sending a message to someone outside.

See:
- `CLAUDE.md` for project context
- `architecture/` for entity model and the layer above the database
- `brainstorm/` for product thesis

## Setup

You bring a Supabase project (the free tier is enough: Postgres, Auth and RLS in
one) and run the web app yourself.

```bash
# 1. Create a project at supabase.com, then copy its URL, anon key and service role key.

# 2. Install and configure.
pnpm install
cp .env.example .env.local
# Required: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
#           SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY (embeddings).
# Optional: INNGEST_* (background schedules), RESEND_API_KEY (email),
#           EXA_API_KEY (web research). The app runs without them.
# Model keys are NOT env vars — you paste those into Settings per workspace.

# 3. Apply the schema, either way:
supabase link --project-ref <ref> && supabase db push
# or, one migration at a time:
pnpm exec tsx scripts/apply_migration.ts supabase/migrations/0001_init.sql

# 4. Run it.
pnpm dev                     # web on localhost:3000
# or the whole thing in containers:
docker compose up --build    # web on :3000, Inngest dev UI on :8288
```

Sign in with a magic link (Supabase Auth emails it). The first user to create a
workspace owns it. Then paste in what you sell, and the system writes its own
research questions and the searches behind them from that description.

## Driving it from an agent

The primary user is an agent, so everything the app does is a tool call. Issue a
key in Settings → API keys and point any MCP client at the endpoint:

```bash
curl -H "Authorization: Bearer acrm_..." -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     http://localhost:3000/api/mcp
```

For Claude Code, Claude Desktop or Cursor, use the stdio bridge in
`packages/mcp-server/` — it proxies to that same endpoint, so the tool catalog
always matches the deployment rather than a copy that drifts.

Every tool publishes a full JSON Schema, so a client knows the arguments without
guessing. Some worth knowing:

| tool | what it does |
| --- | --- |
| `list_approvals` | what is waiting on a person right now, oldest first |
| `add_note` | record what someone told you; with a date it can be the reason a message gets written |
| `research_account` | go and research one company now instead of waiting its turn |
| `pull_contacts` | find decision-makers at an account |
| `read_workspace_config` | what this workspace is configured to look for and argue |
| `cite` | walk a fact back to the page and prompt that produced it |

## Diagnostics (read-only CLI)

The web UI is an audit shell, not a query tool. For ad-hoc "is the pipeline
running / show me the real signals" checks, use these (all read prod via
`.env.local`, default workspace `af602fa1`; set `WORKSPACE_ID=<uuid>` to target
another):

```bash
pnpm status                  # full pipeline overview: active sources, signals by type,
                             #   pipeline output (posts by kind, 24h/7d), enrichment markers,
                             #   LLM + Exa cost (24h / 7d / run-rate), pending gates
pnpm status cost             # full LLM-spend breakdown by model + behavior, plus Exa search cost
pnpm status cost 24          # ...over a custom window in hours (default 168 = 7d)
pnpm status hiring_post      # dump the 20 most recent signals of one type (entity + body + source)
pnpm status research_result 50   # ...any signal type, any count

pnpm research:check          # the entity-research / Exa enrichment loop specifically:
                             #   research_triggered / completed counts + the most recent research_result signals

pnpm hiring:run              # manually run all active ATS sources now (instant fresh data, bypasses the cron)
```

To onboard teammates, go to Settings → Members and invite them by email.

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
- `packages/tools/` — the 33 MCP tools, each emitting one event
- `packages/mcp-server/` — stdio bridge for Claude Code / Desktop / Cursor
- `packages/agents/` — subscription bundles + prompts (lightweight v0 set)
- `packages/db/` — Supabase client + generated types
- `supabase/migrations/` — schema, triggers, RLS, replay function
- `inngest/functions/` — durable agent runtime
- `workers/ingest/` — Python (uv) workers for free-API discovery
- `benchmark/` — head-to-head vs HubSpot baseline (the proof)

## What we are proving

Six falsifiable claims vs HubSpot baseline. See `benchmark/workloads/` and `BENCHMARK.md` (generated).
