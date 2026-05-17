# Project State

Last Update: 2026-05-15 EDT (evening)

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

### Pipeline (end-to-end live as of 2026-05-10, scoring v2 layered 2026-05-15, sweep + source-quality push 2026-05-15 PM)
- Hourly source-dispatcher cron fans out source.run events. Honors per-source `schedule_cron` (YC quarterly, Exa/web every 6h, HN hourly).
- 15 active sources (YC × 3, Exa × 9, web/RSS × 3). Auto-deactivates sources with 0 signals over 7d.
- YC connector emits `yc_directory_update` ONLY when a tracked field changes (team_size, status, isHiring, batch, stage, top_company, one_liner). Snapshot hash stored in `entity.attributes.yc_snapshot_hash`. Kills the 90% duplicate-signal problem at source.
- HN connector: when `watch_entities` is empty, defaults to every workspace account. New entities discovered by Exa/web/yc get watched automatically.
- Exa + Web extraction prompts enforce completeness (every input id must land in `companies` or `rejected` with a structured reason code: `topic_only_no_subject`, `podcast_or_community`, `doesnt_match_filter`, etc.). Listicles/comparisons extract the FIRST 1-2 companies instead of bailing with "ambiguous". Connector surfaces silent LLM drops as errors. Exa extraction rate lifted from ~30% to ~75% average on the same fetches.
- Signals → signal.created (vault-backed pg_net) → match-signal → fan-out
- Enricher: dedupes by signal_body_hash + entity_id (7d window) → asserts facts → auto-links Hunter contacts (negative-cache via `contact_lookup_attempted` fact, 30d TTL) → scoring v2.
- Scoring v2: multi-dim rubric (industry_match, stage_match, signal_strength — LLM) + deterministic (evidence_depth, recency, graph_proximity) + RRF pre-filter via 4-perspective embeddings (default/pain/stack/vertical). Each sub-score asserted as its own `score_*` fact. `icp_fit` kept as alias for backward compat.
- Action selector (deterministic, pre-LLM): draft_outreach (icp_total ≥ 0.65 AND signal_strength ≥ 0.7 AND evidence_depth ≥ 0.5 AND no draft in 14d) / watch_only / deep_research / drop / continue. Replaced the old icp_fit < 0.5 binary gate.
- `research.requested` Inngest event + researchRunner — targeted Exa pull when fit suspected but evidence thin. Writes `research_completed` fact.
- `drop` writes `dropped_until` fact (90d) that hard-suppresses re-evaluation.
- All operational rejections are `decision` channel posts, never gates. Gates reserved for irreversible human approvals (currently unused — no sending pipeline).
- Decision posts on every draft + enrichment (full audit chain)
- Outcome posts when gates decided
- Fact-triggered subscriptions architecture in place (subscriptions.fact_filter column + match_fact RPC + match-fact Inngest function); no fact-triggered subs created yet but infra is live

### Portability foundation (2026-05-15 PM)
- Customer-varying values moved to `workspaces.policy` jsonb. New `packages/tools/src/policy.ts` exposes `WorkspacePolicy` types, `DEFAULT_POLICY`, `getPolicy(supabase, ws_id)`.
- Outreach config (`override_to`, `from_email`, `banned_phrases`, `resend_api_key`) and enrichment toggle (`contact_provider: 'none' | 'hunter'`) live on policy — no more env vars for behavior toggles.
- `sendEmail()` rewritten to take supabase + workspace_id, reads policy at send time. `OUTREACH_OVERRIDE_TO` env removed; `RESEND_API_KEY` env kept as single-tenant fallback.
- agent_logic.ts: workspace-scoped `sanitize()` closure stacks `policy.outreach.banned_phrases` on top of code defaults. Hunter gate becomes `policy.enrichment.contact_provider === 'hunter' && HUNTER_API_KEY` — default `'none'` means new workspaces don't make surprise Hunter calls.
- `scripts/backfill_policy.ts` (idempotent): writes `override_to=jaws.watson@gmail.com`, current banned phrases, `contact_provider='hunter'` to existing workspaces. Must be run once to preserve dog-food behavior.
- Onboarding wizard at `/workspace/new`: name + one plain-English "what should the agent help with" textarea + optional first source + optional Resend key. `POST /api/workspaces/create` does the workspace insert, runs a vertical-neutral LLM derive for `icp/persona/constitution/knowledge_base`, optional starter source — all in one call.
- Home page: 0 workspaces → wizard, 1 → that one, 2+ → picker.
- Settings page reorganized into 4 tabs: Setup / Email / Integrations / Advanced. Plain-language labels ("Writing rules", "What kind of accounts", "Tone"). Friendly fields write back to `policy.outreach.*` and `policy.enrichment.*`; Advanced tab keeps raw-JSON escape hatch.
- New CLAUDE.md section "Portability test": before merging any feature, ask whether a customer can configure it via settings without a code change. Bans hardcoded customer-varying values, new env vars for behavior, and vertical-specific defaults.

### UX surfaces (audit-only) — light pastel theme as of 2026-05-15
- Theme: warm off-white (`#fbfaf6`), soft pastel accents, Inter + JetBrains Mono. CSS variables in `apps/web/app/globals.css`. 3-section sidebar (Main / Configure / Audit).
- **Feed** (`/channels`) — unified chronological action stream replacing entity-grouped view. Filter chips (All/Drafts/Decisions/Claims/Gates), click-to-expand drafts, inline WhyThis + CiteChain. Activity merged in (redirect at `/activity`).
- **Sidebar entity search** — fuzzy name match with ⌘K shortcut, inline dropdown shows kind + icp_fit, jumps to per-entity channel timeline.
- Inbox (`/gates`): approval queue. Empty = healthy. system_health metrics at top.
- Replay: real summary view (counts + top 5 signals with bodies + recent posts + newest entities with sub-score bars). No more raw JSON dump.
- Settings (`/settings`): edit about/icp/persona/constitution/knowledge_base. Saves trigger workspaces.updated_at → rescore cron picks up.
- "Why this?" provenance popover, cite popover, replay slider — themed to new palette.
- / redirects to most-recent workspace's /channels (Feed is now the center)

### Observability
- agent_run_metrics event emitted per LLM call (model, behavior, input/output/cached tokens, signal_body_hash for dedup)
- token_summary MCP tool + /api/admin/health exposes tokens_24h + tokens_7d, cache_rate, action_distribution (draft/watch/research/drop/continue counts), tokens_per_drafted_touch, tokens_per_scored_account
- Per-source signals_7d in `sources.last_run_summary` for yield tracking
- No pricing tables (per user direction): raw token counts only
- **Sweep** (`pnpm sweep`): 10 deterministic SQL checks across 4 tiers (signal diversity / silence / cost / scoring health) with RED/YELLOW/GREEN output and deterministic ACTION templates. Same `sweepWorkspace()` function in `@agent-crm/tools` is called from:
  - SessionStart hook in `.claude/settings.json` — red flags surface at the top of every session automatically
  - hourly `systemHealthMonitor` cron — RED on tier-1/3/4 checks opens a gate (with 12h cooldown). Tier 2 (cron staleness, agent silence) skipped here to avoid double-alerts with existing `healthCheck`
- Debug tools: `scripts/debug_extraction.ts --type=exa|web` runs the extraction pipeline against a real source without writing signals, dumps LLM input + output + rejection reasons. `scripts/inspect_sources.ts` lists all sources + last_run_summary. `scripts/trigger_exa_runs.ts` forces immediate dispatch of `source.run` events for a given connector_type
- Diagnostic scripts fixed against real schema (events.created_at not .ts; signal_source under structured_tags; channel_posts joined via channels; gates.decided_at not .status)
- check_stuck.ts, audit_state.ts, audit_subscriptions.ts, sample_recent_posts.ts, check_processing.ts, probe_matcher.ts, dismiss_operational_gates.ts — operator diagnostics

## Known issues (deferred)

- IndieHackers RSS feed returns 0 raw items (feed URL or content-type changed). Lenny's and TechCrunch parse fine.
- RSS false-positive entity creation: tightened again in 2026-05-15 prompt push, still imperfect
- Render auto-deploy webhook broken — user reconnecting GitHub App; manual redeploys for now
- A handful of accounts have `.example` placeholder domains and can't get Hunter contacts
- No sending pipeline — drafts stay in Inbox forever; human copy-pastes manually
- Auto-mode classifier blocks `git push origin main` and bulk DB updates even after explicit AskUserQuestion approval; user has to run those manually

## Plan File

Most recent: `zany-bouncing-pascal.md` — Portability foundation. Phase A (policy.ts + send_email + agent_logic + backfill_policy.ts), Phase B (wizard + /api/workspaces/create + home routing + tabbed Settings), Phase C (Portability test in CLAUDE.md). Shipped end-to-end; backfill must be run once.

Prior: no formal plan for the sweep PM session — design generated inline (10 checks across 4 tiers). Earlier: `quirky-mapping-pinwheel.md` (Scoring v2 + UI overhaul); `mellow-finding-noodle.md` (drafter consolidation, fact-triggered subs, ICP rescore, token obs).

## Open Questions

- Reactions / outcomes UI design (outcome post exists per gate decision, but no aggregated "outcomes I care about" view)
- Multi-tenant embedding strategy (defer to design partner)
- Memory hierarchy (L1 prompt → L4 cold) — design vs let it emerge from cost pressure
- Where Sim/MCP plugs in as the action layer
- pgvector HNSW quality at >100k vectors per index (test before assuming)
- TAM at the sharp end (ops teams >1K autonomous touches/month, ~2K companies)
- Per-tenant Hunter quota tracking (single workspace today)
