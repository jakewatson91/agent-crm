# Project State

Last Update: 2026-05-14 22:00 EDT

## Direction

Agent-first CRM. Primary user is the agent; humans intervene only at exception gates. Wedge is the abstraction layer above commodity DB (Postgres + pgvector + RLS), not the DB itself.

**Architecture is the moat.** Events + facts + provenance + replay + concurrency. Knowledge bases, drafter formula, NL config, constitution field, meta-agent routing — all commodities. Never pitch a surface feature as defensible.

**v0 strategy:** Build foundation + abstraction layer, prove it's measurably better for agent workloads than HubSpot via a 6-claim benchmark, then pick a use case once the architecture is validated. Currently dog-fooding as a real CRM the agent operates on — sourcing AI-native + GTM-tool-buyer prospects.

## Stack confirmed

- Supabase (Postgres + pgvector) — hosted
- Inngest cloud as durable runtime — vault-backed pg_net trigger publishes signals/facts/gates to webhook
- Next.js 15 viewer on Render (Free tier, kept warm by cron-job.org ping at /api/health)
- OpenAI for agent calls (Anthropic API blocked at the account level — see CODING.md). OpenRouter routing via model id containing `/`
- Default LLM = OpenAI; do NOT introduce `@anthropic-ai/sdk` calls
- **Dev workflow**: `pnpm --filter web dev` against prod Supabase via .env.local — push only for prod cron / customer-facing changes

## Hard rules (in CLAUDE.md + memory)

- **Agent-first or it doesn't ship.** Banned: pipeline views, sortable tables, kanban, batch ops, in-app feeds. Allowed human surfaces: gates (approval), audit (verify agent state), config.
- **No new agents.** Closed set: claim_poster, drafter, enricher. Solve via tools, prompts, post-processors.
- **Real, scalable solutions.** No app-side fetch hacks for things that belong in the DB.
- **Not sending emails.** Drafts stay in Inbox; human still copy-pastes.

## v0 Benchmark progress

- **Workload 1:** 1.28× tokens vs HubSpot — done
- **Workload 3:** 96% HubSpot data loss vs us — done
- **Workloads 4/5/6:** next
- Lead any pitch with the **concurrency** result, not tokens

## What's Built

### Foundation (week 1)
- 8 migrations live: schema, triggers, RLS, replay, query similarity, deferrable FKs, RPC grants, bootstrap fix
- Event sourcing: `events` is source of truth, append-only at SQL grant level
- Content-addressed facts (sha256 idempotent), supersede chains
- Subscription matching: GIN structured filter + pgvector cosine in single SQL
- Replay: `replay_to(workspace_id, ts)` reconstructs state at any past timestamp
- 5 primitives (subscribe, act, gate, query, cite) — Zod-validated
- 17 MCP tools — full read + write surface for agents
- Inngest functions: match_signal, match_fact, on_subscription_matched, agent_run, notify_on_gate, source_dispatcher, source_run, recover_unmatched_signals, system_health_monitor, rescore_on_icp_change

### Prod deployment (2026-05-09 → 05-10)
- Render Free tier hosting Next.js + /api/inngest webhook
- Vault-backed pg_net triggers for signal.created, fact.created, gate.created
- INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY synced; Inngest cloud has 10 functions registered
- cron-job.org pings /api/health every 10 min to keep Render warm
- HUNTER_API_KEY set in Render for contact enrichment
- Manual deploy (auto-deploy webhook is broken on Render→GitHub side — needs reconnect)

### Agent capabilities (MCP tools)
- Reads: list_entities, get_entity, outreach_state, health_check, find_similar_entities, lookup_entity, past_outcomes, token_summary
- Writes: create_workspace, create_account, create_contact, assert_fact, supersede_fact, create_signal, create_subscription, post_to_channel, request_gate, decide_gate
- Enrichment: find_contacts (Hunter.io), link_contact_to_account, score_entity (ICP-anchored), query, cite

### Pipeline (end-to-end live as of 2026-05-10)
- Hourly source-dispatcher cron fans out source.run events
- 15 active sources (YC × 3, Exa × 9, web/RSS × 3)
- Signals → signal.created (vault-backed pg_net) → match-signal → fan-out
- Enricher: asserts facts → auto-links Hunter contacts (if domain) → universal ICP scoreAndAssert
- Universal drafter (outbound_drafter): reads icp_fit + past_outcomes + contacts; gates if icp_fit < 0.30; otherwise drafts with To: <email>
- Decision posts on every draft + enrichment (full audit chain)
- Outcome posts when gates decided
- Fact-triggered subscriptions architecture in place (subscriptions.fact_filter column + match_fact RPC + match-fact Inngest function); no fact-triggered subs created yet but infra is live

### UX surfaces (audit-only)
- Inbox (was /gates): approval queue. Empty = healthy. Shows system_health metrics at top.
- Feed (was /channels): list_entities projection. Shows status, top contact, icp_fit (color-coded), draft preview. Sort by activity or icp_fit.
- Activity: raw event log
- Constitution (/settings): edit about/icp/persona/constitution/knowledge_base. Saves trigger workspaces.updated_at → rescore cron picks up
- "Why this?" provenance popover, cite popover, replay slider — all from earlier sessions
- / redirects to most-recent workspace's /gates (no auth, single-tenant dog-food)

### Observability
- agent_run_metrics event emitted per LLM call (model, behavior, input/output/cached tokens)
- token_summary MCP tool + /api/admin/health exposes tokens_24h + tokens_7d
- No pricing tables (per user direction): raw token counts only
- check_stuck.ts, audit_state.ts, audit_subscriptions.ts, sample_recent_posts.ts, check_processing.ts, probe_matcher.ts — operator diagnostics

## Known issues (deferred)

- RSS false-positive entity creation: tightened in 2026-05-10 push (looksLikeHandle filter + multi-company disambiguation prompt), but still imperfect
- Render auto-deploy webhook broken — user reconnecting GitHub App
- HN sources are watch-mode only; 3 misconfigured ones deactivated. Discover-mode HN connector not built.
- 6 of 76 accounts have `.example` placeholder domains and can't get Hunter contacts
- No sending pipeline — drafts stay in Inbox forever; human copy-pastes manually

## Plan File

`/Users/jakewatson/.claude/plans/quirky-mapping-pinwheel.md` — 2026-05-14 status check + credit-efficiency push. Shipped: pre-LLM short-circuits, no more operational gates, prompt-cache fix (preamble brings enricher to 1524 tokens), per-source schedule_cron enforcement, Hunter negative-result cache, source yield auto-deactivate, tokens-per-output metrics, diagnostic-script schema fixes, ICP backfill via cron.

Prior: `mellow-finding-noodle.md` (drafter consolidation, fact-triggered subs, ICP rescore, token obs).

## Open Questions

- Reactions / outcomes UI design (outcome post exists per gate decision, but no aggregated "outcomes I care about" view)
- Multi-tenant embedding strategy (defer to design partner)
- Memory hierarchy (L1 prompt → L4 cold) — design vs let it emerge from cost pressure
- Where Sim/MCP plugs in as the action layer
- pgvector HNSW quality at >100k vectors per index (test before assuming)
- TAM at the sharp end (ops teams >1K autonomous touches/month, ~2K companies)
- Per-tenant Hunter quota tracking (single workspace today)
