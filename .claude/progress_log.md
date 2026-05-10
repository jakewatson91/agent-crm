# Completed Log

## 2026-05-08 — Week 1 foundation shipped

### Plan
- Iterated through 5 rounds of plan revisions before approval. Final framing: build foundation + 6-claim benchmark vs HubSpot, defer use case selection.
- Plan file at `/Users/jakewatson/.claude/plans/happy-puzzling-pearl.md`.

### Database (live on Supabase)
- 8 migrations applied to remote project `spqzaxzgdzqsjuxdqfxm`:
  - `0001_init.sql` — full schema (workspaces, entities, entity_embeddings, events, facts, signals, subscriptions, channels, channel_posts, touches, outcomes, gates, conversations, projections_cache) with HNSW indexes on embeddings, GIN on jsonb filters
  - `0002_triggers.sql` — `record_event()` (transactional event + projection upsert), `notify_inngest_signal/gate()` (pg_net webhook fan-out), `match_signal_to_subscriptions()` (single-SQL matching)
  - `0003_rls.sql` — workspace-scoped RLS on every table, `is_workspace_member()` helper, events table append-only at grant level
  - `0004_replay_fn.sql` — `replay_to(workspace_id, ts)` returns full projection snapshot at any past timestamp
  - `0005_query_fns.sql` — `query_facts_by_similarity()` cosine ranking via entity_embeddings join; `invalidate_projections()` trigger
  - `0006_deferrable_fks.sql` — events.workspace_id FK deferrable so create_workspace bootstrap works in one tx
  - `0007_rpc_grants.sql` — explicit execute grants on RPC functions for PostgREST exposure + schema reload notify
  - `0008_fix_record_event_bootstrap.sql` — special-case create_workspace path: allocate workspace id first, use it as event's workspace_id

### Code (typechecks clean across 6 packages)
- `packages/primitives/` — 5 primitives (subscribe, act, gate, query, cite), Zod-validated, OpenAI embedding wrapper pinned to text-embedding-3-small (1536 dim)
- `packages/tools/` — 13 MCP tools with single-dispatch via `callTool()`, Zod schemas per tool
- `packages/agents/` — placeholder registry interface; week 2 fills in
- `packages/db/` — Supabase server + anon client factories
- `inngest/` — durable runtime: match_signal, on_subscription_matched, agent_run stub, notify_on_gate
- `apps/web/` — Next.js 15 viewer: pages for gates / activity / channels / channels/[id] / query / replay; api routes for primitives/{act,query,replay}, /api/mcp (JSON-RPC tools/list + tools/call), /api/inngest webhook

### Tests + demo
- `scripts/smoke_test.ts` — green; verifies workspace creation, idempotent fact assertion, cite chain, embeddings, semantic+structured subscription matching, replay correctness, append-only event grant
- `scripts/seed_demo.ts` — creates workspace with 6 accounts, facts (with one supersede chain on Resona), 5 signals, 2 subscriptions, channel posts of every kind including a drafter→critic thread, 3 gates (2 pending, 1 decided)
- `scripts/inject_claim.ts` — registers a brand-new claim subscription with arbitrary owner_id at runtime; proves no code change needed to add an "agent"
- Reframed seed and inject from role-shaped owner ids (drafter, critic, etc.) to claim-shaped owner ids (claims_outreach_drafts, claims_unsourced_drafts, etc.) per Moltbook architectural decision

### Operational
- Dev server running at localhost:3000 against live Supabase
- `.env.local` symlinked into apps/web/ so Next.js picks up env vars
- Found and fixed: `NEXT_PUBLIC_SUPABASE_URL` had `/rest/v1/` trailing → caused PGRST125 on every PostgREST request. Always pass just the project URL; supabase-js appends the path.

### Global rules
- CONSTITUTION §3 extended with named-offender anti-jargon rule (substrate, predicate, abstraction layer, primitive, wedge → plain English alternatives). Scope explicitly widened to code comments + plan docs + READMEs + page text + chat replies.

## 2026-05-09 — Agent runtime, UX moat surfacing, Sprint 3 audit fixes

### Agent runtime + connectors
- NL-driven agent creation. No dropdowns. Users paste model IDs + API keys themselves.
- Connector model: Presets (hn, yc, github, producthunt) + Tools (api_call, exa, web) + Custom. Not source-based lists.
- Connectors live: YC directory, Exa, RSS feeds (TechCrunch, IH, Lenny's), web scraping, custom api_call.
- Watch mode vs Discover mode.
- Workflow ordering enforced: enricher → claim_poster → drafter.
- Agent behaviors: claim_poster, drafter, enricher.
- OpenAI + OpenRouter routing via model id containing `/`.
- Prompt caching working: 91% cache hit observed (OpenAI 1024-token threshold).

### UX surfaces for the architectural moat
- `apps/web/app/_components/WhyThis.tsx` — "Why this?" popover per channel post. Opens side panel with replay_to(post.created_at - 1ms) showing facts/signals the agent saw at decision time, with cited facts highlighted.
- Cite popovers wired throughout.
- Activity timeline as ambient surface.
- Replay slider repurposed as secondary audit/compliance surface; "Why this?" is the everyday hook.

### Workspace identity + drafter formula
- `workspaces.constitution` column added (replaces forbidden "writing rules" name).
- `workspaces.about` column added.
- Drafter formula baked into prompt: ONE-word subject, accusation audit, problem statement, one-liner, ask.
- Banned-phrase post-processor (`sanitizeText`).
- Knowledge base mapping layer (prospect pain → our angle).

### v0 benchmark results (so far)
- Workload 1: 1.28× tokens vs HubSpot.
- Workload 3: 96% HubSpot data loss vs us.
- Workloads 4/5/6 pending.

### Bug fixes along the way
- OpenAI 400 "messages must contain word 'json'" → fixed by prepending "Extract items… return JSON" to user message.
- RSS discover mode skipped all items → added `enrichItemsWithCompanyName()` batched LLM call.
- Hydration warnings → `suppressHydrationWarning` on Timestamp + lazy-init for replay's date state.
- LLM model parsing in meta-agent → removed; users supply their own model id.
- Resona repetition (50+ concurrency_test facts polluting demo) → `scripts/cleanup_resona.ts` surgical cleanup. Deletes test posts/facts/signals; keeps entity, channel, seed facts, hiring fact, all events (events are append-only).

### Sprint 3 content-quality audit (REVIEW3.md) — top 3 fixes
- **Draft suppression** in `inngest/functions/agent_logic.ts`. Default 7-day window via `policy.draft_suppression_days`. If a `touch_draft` exists in channel within window, fire gate with `policy=draft_already_exists` instead of writing duplicate. Kills Ventura-4-drafts pattern.
- **Drafter reasons over fact-richness, not `is_hiring`.** `DRAFTER_DECISION` prompt rewritten with 3 ordered rules: ≥3 substantive facts → draft regardless of literal filter match; off-ICP → gate `off_icp`; thin facts → gate `thin_facts`. Filter is "PRIORITIZATION SIGNAL, not a hard constraint." Unblocks Scheduling Wizard (4 hospital customers + UCSF partnership), Talking Computers, Ndea, OpenSpec.
- **ICP gate at entity creation** — built (`inngest/functions/sources/icp_gate.ts` + integration into web.ts and api_call.ts), then **reverted in this session per user decision**. RSS false-positive entities remain a known but deferred issue.

### Architectural framing locked in
- "Architecture is the moat" memory saved (`feedback_architecture_is_the_moat.md`). Events + facts + provenance + replay + concurrency are defensible. KB, drafter formula, NL config, constitution field, meta-agent routing — all commodities. User pushed back hard when KB framed as core value: "If you really think that this is the core value then we might as well stop building this now."
- Confirmed: existing system is event-sourced storage + event-driven runtime + pub/sub on filters, on Postgres + Inngest. The `events` table IS the source of truth (not a transient bus), which is what makes `replay_to(timestamp)` possible.
