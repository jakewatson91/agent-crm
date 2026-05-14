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


## 2026-05-09 → 05-10 — Prod deployment + full pipeline

### Plan
`/Users/jakewatson/.claude/plans/mellow-finding-noodle.md` — multiple iterations: deploy → contacts/outcomes/source-quality → drafter consolidation + fact triggers + ICP rescore + token obs.

### Done

**Deploy stack**
- Render Free tier deploying Next.js app + /api/inngest webhook
- Inngest cloud sync working with 10 functions registered including new cron jobs
- Vault-backed pg_net trigger for signal/fact/gate (replaces broken GUC approach — Supabase blocks ALTER DATABASE SET app.* for postgres role)
- HUNTER_API_KEY + INNGEST_* keys in Render env
- /api/health endpoint to silence keepalive log noise; cron-job.org pings every 10 min
- Lowered Inngest function concurrency to 5 (free plan limit)
- maxDuration=300 + dynamic='force-dynamic' on /api/inngest
- 4-tier package monorepo deploys via `pnpm install --frozen-lockfile && pnpm --filter web build`

**Audit / observability infra**
- Renamed: Gates → Inbox (approval queue), Channels → Feed (agent activity)
- Inbox health panel (system_health_monitor cron creates gates when stale)
- Decision posts on every drafter + enricher run with reasoning + cites
- Outcome posts when gates decided
- agent_run_metrics event written per LLM call; token_summary aggregates by model/behavior; /api/admin/health surfaces tokens_24h + tokens_7d
- "Why this?" provenance walks already worked from earlier sprints; now also chain through decision posts

**Agent capability surface (MCP tools)**
- list_entities, get_entity, outreach_state, health_check, find_similar_entities, lookup_entity, past_outcomes, token_summary (reads)
- find_contacts (Hunter), link_contact_to_account, score_entity (writes/enrichment)
- Universal ICP scoring: auto-runs after every enricher; asserts icp_fit fact via supersede chain; drafter prompt gates at icp_fit < 0.30

**Pipeline consolidation**
- Single universal outbound_drafter replaces 4 source-specific drafters
- Single universal score_entity (workspace-wide ICP) replaces 5 per-source scorers
- 122-signal backlog recovered by manually emitting signal.created events to Inngest event API after vault setup
- 4 misconfigured HN watch-mode sources deactivated

**Fact-triggered subscriptions (architectural)**
- Migration 0020: subscriptions.fact_filter jsonb + match_fact_to_subscriptions RPC + notify_inngest_fact trigger
- New Inngest event fact.created; new match-fact function
- subscription.matched + agent.run events extended with optional fact_id; agent_logic synthesizes a signal-shaped payload when fact-triggered
- Backward compatible: subs without fact_filter only match signals

**ICP iteration loop**
- Migration 0019: workspaces.updated_at + auto-update trigger
- New cron rescore-on-icp-change (every 30min): re-runs scoreAndAssert for entities whose icp_fit is older than workspace update
- scripts/rescore_all.ts for bulk one-shot
- Inbox shows icp_fit per row (color-coded) + sort toggle

**Hard rules locked into CLAUDE.md + memory**
- "Agent-first or it doesn't ship" — banned pipeline/sortable/kanban/batch/in-app feed patterns
- "No more agents" — closed set: claim_poster, drafter, enricher
- "No duct tape" — vault-backed triggers, not app-side fetch
- "Local dev for UI/logic, push only for prod cron" — pnpm --filter web dev against prod Supabase

### Trade-offs / decisions
- Skipped a /login page; app redirects / → workspace/<id>/gates. Single-tenant dog-food.
- Skipped pricing tables for token observability (per user feedback "model pricing is stupid"). Raw token counts only.
- Skipped Inngest webhook for sources; pull-based cron is right for v0 discovery.
- pg_net's net.http_post requires body as jsonb (not text); original migration 0002 had a latent bug that surfaced once vault populated.

### Deferred / known issues
- Render auto-deploy webhook broken — user reconnecting GitHub App
- HN discover-mode connector not built
- 6 entities have .example placeholder domains; no Hunter contacts possible
- No sending pipeline — drafts stay in Inbox; human copy-pastes
- RSS multi-company attribution still imperfect despite tightened prompt


## 2026-05-14 — Status check + credit-efficiency push

### Plan
`/Users/jakewatson/.claude/plans/quirky-mapping-pinwheel.md`. Audit-then-fix session triggered by "check if crons have been running, what state is data, anything broken, what to work on next."

### Audit findings (last 7d of prod)
- Crons alive: 463 events in 6h, 467 signals/24h (432 YC, 23 Exa, 12 web)
- Exa out of credits (9 sources 402'ing for days)
- 200+ open gates, ~all "operational" rejections (off_icp, thin_facts, draft_already_exists, low_confidence, LLM-verbose policy strings)
- 170 of 211 accounts unscored — drafter gates everything at icp_fit<0.30
- Prompt cache hit rate = 0.1% (was 91% per 05-09)
- Only 2 touch_drafts in 24h despite hundreds of signals
- 4 diagnostic scripts silently producing wrong numbers (wrong column names — events.ts, signals.signal_source, channel_posts.workspace_id, gates.status)

### Credit-spend audit ($95/mo at current volume)
- Hunter: $62/mo, 65% of spend, 86% of accounts with a real domain have ZERO contacts. Hunter re-called on every enricher run because no negative-result marker.
- Exa: $32/mo. Connector authors set schedule_cron to */6h or daily but dispatcher fired all sources hourly — 6-24× over-run.
- OpenAI chat: $1.40/mo. Cache regression was real but absolute spend tiny at current volume.
- Embeddings: $0.02/mo. Negligible.

### Shipped this session

**Agent-first compliance (drafter / enricher)**
- Pre-LLM short-circuits in `agent_logic.ts`: enricher dedupes via signal_body_hash + entity_id (7d window); drafter skips on icp_fit<0.5, <3 substantive facts, draft-already-exists, daily-cap, suppression match
- All operational rejections now emit `decision` channel posts (no gates)
- Post-LLM `request_gate` action also converted to decision post — gates reserved for irreversible human actions only
- New `noteDecision` helper replaces `gateAndPost` in operational paths
- `scripts/dismiss_operational_gates.ts` cleanup for the 211 historical gates

**Credit-efficiency**
- Prompt cache fix: added SYSTEM_PREAMBLE (~450 tokens of stable grounding context) pushing enricher system prompt from 1009 → 1524 tokens, above OpenAI's 1024-token cache minimum. Verified live: second call cached 1024/1391 = 73.6% hit on input.
- Hunter negative-result cache: writes `contact_lookup_attempted` fact on 0-result. 30d TTL. Stops re-billing for dead domains.
- `dispatcher.ts` honors per-source `schedule_cron`. Parser handles all 6 patterns the registry emits (* / * /N min / * /N hour / fixed hour / daily). 10% slack window. YC + ProductHunt: 24× → 1× daily. Exa + web + api_call: 6× → 1× per 6h.
- Per-source yield tracking in `sources.last_run_summary.signals_7d`. Auto-deactivates sources with 0 yield over 7d (with >7d age guard so new sources aren't killed).
- `/api/admin/health` exposes `tokens_per_drafted_touch`, `tokens_per_scored_account`, `cache_rate` over 24h and 7d.

**Hygiene**
- Diagnostic scripts (`audit_state.ts`, `check_stuck.ts`, `check_processing.ts`) fixed to use real schema (`events.created_at`, `structured_tags->>signal_source`, channel-join for `channel_posts`, `gates.decided_at`)
- `system_tasks.ts` rescore-on-icp-change cron now also picks up accounts with NO icp_fit fact, not just stale ones. 50/30min → full backfill in ~2 hours.

**Projected monthly spend after deploy + cron cycles**
- Hunter: $62 → ~$18 (-70%)
- Exa: $32 → ~$5 (-83%, when topped up)
- OpenAI: $1.40 → ~$1.00
- Total: ~$95/mo → ~$25/mo (~75% reduction, no quality hit)

### Auto-mode classifier note
Blocked `dismiss_operational_gates.ts --apply` twice even after explicit user approval via AskUserQuestion. User ran it themselves after.
