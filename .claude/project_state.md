# Project State

Last Update: 2026-05-09 15:11 EDT

## Direction

Agent-first CRM. Primary user is the agent; humans intervene only at exception gates. Wedge is the abstraction layer above commodity DB (Postgres + pgvector + RLS), not the DB itself.

**Architecture is the moat.** Events + facts + provenance + replay + concurrency. Knowledge bases, drafter formula, NL config, constitution field, meta-agent routing — all commodities. Never pitch a surface feature as defensible.

**v0 strategy:** Build foundation + abstraction layer, prove it's measurably better for agent workloads than HubSpot via a 6-claim benchmark, then pick a use case once the architecture is validated. Currently dog-fooding on Jake's job hunt as the first test surface.

## Stack confirmed

- Supabase (Postgres + pgvector) from day one
- Inngest as durable runtime — pg_net trigger publishes signals/gates to webhook
- Next.js 15 viewer
- OpenAI for agent calls (Anthropic API blocked at the account level — see CODING.md). OpenRouter routing via model id containing `/`
- Default LLM = OpenAI; do NOT introduce `@anthropic-ai/sdk` calls

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
- 13 MCP tools with single-dispatch via callTool
- Inngest functions: match_signal, on_subscription_matched, agent_run, notify_on_gate

### Agent runtime + UX (recent sessions)
- NL-driven agent creation (no dropdowns; users paste model IDs + API keys)
- Presets (hn, yc, github, producthunt) + Tools (api_call, exa, web) + Custom — not source-based connector lists
- Connectors: YC directory, Exa, RSS feeds (TechCrunch, IH, Lenny's), web scraping, custom api_call
- Watch mode vs Discover mode
- Knowledge base mapping layer (prospect pain → our angle)
- Workspace-level **constitution + about** fields (NOT "writing rules" — that name is forbidden)
- Drafter formula baked in: ONE-word subject, accusation audit, problem statement, one-liner, ask
- Banned-phrase post-processor (sanitizeText)
- Workflow ordering: enricher → claim_poster → drafter
- Agent behaviors: claim_poster, drafter, enricher
- Prompt caching: 91% cache hit observed (OpenAI 1024-token threshold)

### UX surfaces for the architectural moat
- "Why this?" popover per channel post — opens panel with replay_to(post.created_at - 1ms) showing facts/signals the agent saw at decision time, with cited facts highlighted (`apps/web/app/_components/WhyThis.tsx`)
- Cite popovers
- Activity timeline (ambient — "you don't need to read it")
- Replay slider repurposed as audit/compliance secondary surface; "Why this?" is the everyday hook
- /gates is home page; empty 95% of the time = healthy

### Sprint 3 audit fixes (this session, shipped)
- **Draft suppression** in `inngest/functions/agent_logic.ts` — before drafting, checks for existing `touch_draft` in channel within window (default 7d, configurable via `policy.draft_suppression_days`). If found, fires gate with `policy=draft_already_exists` instead of writing duplicate. Kills the Ventura-4-drafts pattern.
- **Drafter reasons over fact-richness, not `is_hiring`** — `DRAFTER_DECISION` prompt rewritten with 3 ordered rules: ≥3 substantive facts → draft regardless of literal filter match; off-ICP → gate `off_icp`; thin facts → gate `thin_facts`. Filter is a "PRIORITIZATION SIGNAL, not a hard constraint." Unblocks Scheduling Wizard (4 hospital customers + UCSF), Talking Computers, Ndea, OpenSpec.

## Reverted / not done

- **ICP gate at entity creation** (web.ts + api_call.ts) — built then explicitly reverted per user. `inngest/functions/sources/icp_gate.ts` deleted; imports + icpDecisions Map + candidate-collection blocks removed from both connectors. RSS false-positive entities (manishbhusal, Stripe, Hatch, Kodiak AI) remain a known issue but are NOT a priority right now.

## Known issues (deferred)

- RSS false-positive entity creation: 4 per typical run (Indie Hackers username-as-company bug, multi-company article extraction picking the wrong subject)
- Per-source extraction prompts not built
- Web-source enrichment gap: `claims_audit_yc_enricher` filter is `signal_source: yc`, so web-sourced entities (Stripe, Kodiak, Hatch, Kalshi, Ramp) get NO enrichment
- Multi-company articles attributed to one entity (e.g. Ramp draft references Corgi's funding)

## Plan File

`/Users/jakewatson/.claude/plans/happy-puzzling-pearl.md` — week 1 foundation plan (now historical reference).

## Open Questions

- Reactions / outcomes UI design (entity exists but no surfacing)
- Multi-tenant embedding strategy (defer to design partner)
- Memory hierarchy (L1 prompt → L4 cold) — design vs let it emerge from cost pressure
- Where Sim/MCP plugs in as the action layer
- pgvector HNSW quality at >100k vectors per index (test before assuming)
- TAM at the sharp end (ops teams >1K autonomous touches/month, ~2K companies)
