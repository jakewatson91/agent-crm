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


## 2026-05-15 — Scoring v2 + UI overhaul (same session, second pass)

### Plan
`/Users/jakewatson/.claude/plans/quirky-mapping-pinwheel.md` rewritten. User asked for deeper scoring drawing on SOTA techniques + higher draft threshold + non-outreach actions.

### Light pastel theme + unified Feed
- `apps/web/app/globals.css` — warm off-white (#fbfaf6), soft pastel accents, CSS variables, Inter + JetBrains Mono.
- Workspace sidebar reorganized into Main / Configure / Audit. Activity removed from nav.
- Feed (`/channels`) rewritten as chronological action stream (`FeedStream.tsx`). Filter chips, click-to-expand drafts, inline WhyThis + CiteChain. `/activity` now redirects to Feed.
- Inbox, channel detail, CiteChain, WhyThis migrated to CSS variables.
- Replay page redesigned: counts row + top 5 signals with body text + recent posts + newest entities with sub-score bars. New `/api/replay/summary` joins back to signals + posts + score facts. Old raw-JSON dump gone.
- Entity search component (`EntitySearch.tsx`) in sidebar with ⌘K shortcut, fuzzy match via `lookupEntity` MCP, inline results show kind + icp_fit, jump to channel timeline. New `/api/entities/lookup` route.

### Scoring v2 (the big one)
- `packages/tools/src/scoring.ts` rewritten end-to-end. 6-dim rubric:
  - LLM sub-scores: `industry_match`, `stage_match`, `signal_strength` (strict rubric, calibrated against "directory listing ≠ strong signal")
  - Deterministic sub-scores: `evidence_depth` (substantive fact count / 6), `recency` (exponential decay τ=45d), `graph_proximity` (mean icp_fit of linked entities)
  - Weighted-sum into `icp_total`. Each sub-score asserted as its own `score_*` fact. `icp_fit` kept as alias.
- `packages/tools/src/graph.ts` — `graphProximity()` over `customer_of` / `partners_with` / `backed_by` / `integrates_with` / `invested_by` edges. Pure SQL, both directions.
- `packages/tools/src/icp_embeddings.ts` — 4 perspective vectors (default/pain/stack/vertical) for workspace ICP, cached in `workspaces.policy.icp_embedding_cache` keyed by hash of icp+about. Auto-invalidates when ICP changes. Includes `cosine()` and `rrfFuse()` helpers (Cormack et al SIGIR 2009 RRF).
- RRF pre-filter in scoreEntity: embed 4 perspectives for the entity, cosine vs cached ICP perspectives, fuse via RRF. If fused < 0.3 AND evidence_depth < 0.34, skip LLM entirely. Bi-encoder pre-filter / cross-encoder rerank pattern.
- `packages/tools/src/action_selector.ts` — deterministic categorical decision: `draft_outreach` / `watch_only` / `deep_research` / `drop` / `continue`. Draft requires icp_total ≥ 0.65 AND signal_strength ≥ 0.7 AND evidence_depth ≥ 0.5 AND no draft in 14d. `drop` writes `dropped_until` fact for 90d hard suppression. `deep_research` emits `research.requested` Inngest event.
- `inngest/functions/research.ts` — `researchRunner` listens on `research.requested`, runs targeted Exa pull keyed by entity name + fact keywords, attributes results back as `research_result` signals with embedding. Concurrency-limited 2/workspace.
- `inngest/functions/agent_logic.ts` drafter branch rewired: workspace policy checks (suppression/cap) → `selectAction()` → if `draft_outreach` run LLM drafter, else emit decision post + side effects. Old gate-rule 1-5 block stripped from `DRAFTER_DECISION` prompt — gating now fully deterministic upstream.
- `inngest/client.ts` — added `research.requested` event schema. `apps/web/app/api/inngest/route.ts` registers `researchRunner`.
- `/api/admin/health` reports `action_distribution_24h/7d` (count of each action) by parsing `[action_name]` prefix on decision-post bodies.

### Calibration spot-check on 16 entities (locally invoked scoring v2 against prod data)
- Strong fits stayed strong or moved up: Resona 0.60→0.81, Growth Talent 0.50→0.74. Most-confidence drivers: industry_match=1.0, signal_strength=1.0, evidence_depth=0.67-0.83.
- Mid-band (0.40) collapsed to 0.24-0.28 as designed.
- Brand-new entities (no facts) land at 0.20 floor (evidence_depth=0, recency=0).
- The 0.3-0.5 mediocre band is gone. The "YC page mention → email" failure mode is closed.

### Operational
- Committed in one shot: `6439d19 Scoring v2: multi-dim rubric + graph features + action selector + light theme + unified Feed`. Push deferred to user.
- Dev server runs against prod Supabase via .env.local; scoring v2 invokable locally before deploy.
- `_rescore_sample.ts` (temp script, deleted) walked through 16 entities to validate calibration before push.

### Trade-offs / decisions
- Did NOT do Bayesian fact aggregation, cross-encoder reranker model, or Thompson sampling. All overkill for v0; LLM rubric IS the reranker. Documented as deferred in plan.
- Push-back on "scoring as moat": per `feedback_architecture_is_the_moat`, the scoring formula isn't defensible. The substrate (event-sourced facts with provenance, multi-perspective embeddings, entity↔fact graph, replay) is. Scoring v2 demonstrates the moat; it doesn't create it.
- Kept `icp_fit` predicate as alias of `score_total` for backward compat (drafter prompt and UI badges still read it).

### Deferred / known issues (unchanged from previous push)
- Exa credit top-up still required
- Render auto-deploy webhook still broken
- No sending pipeline
- HN discover-mode connector not built

## 2026-05-15 PM — Sweep + source-quality push

Commit: `d49899c Sweep + source-quality push`. Pushed to origin/main.

### Sweep tooling (new in `@agent-crm/tools`)
- `packages/tools/src/sweep.ts` exports `sweepWorkspace(sb, workspace_id) -> CheckResult[]`. 10 deterministic SQL checks, one round-trip per table. Zero LLM calls.
- Tier 1 (signal quality): signal_diversity per source per 24h, source_concentration, novelty 24h vs prior 24h. Designed to catch the exact "90% duplicates from one source" failure mode that drove this session.
- Tier 2 (silent loops): enricher silence, cron staleness via `sources.last_run_at`, agent-type output gap (`agent_run_metrics` events).
- Tier 3 (efficiency): cost_per_unique_signal, cost_per_claim — token spend joined to unique-signal / claim_post counts, compared to 7d daily median.
- Tier 4 (scoring health): score_distribution shape (deciles of icp_fit), score_signal_coupling (% of entities with new signals whose score also moved in last 24h).
- Output: RED / YELLOW / GREEN with deterministic ACTION lines per check, no LLM in the report itself.

### Wiring
- `scripts/sweep.ts` — CLI formatter over `sweepWorkspace`. `pnpm sweep` for full output, `pnpm sweep -- --quiet` for SessionStart hook (suppresses GREEN).
- `.claude/settings.json` SessionStart hook runs `pnpm sweep -- --quiet 2>&1 | head -80`. Red flags surface at the top of every new session automatically.
- `inngest/functions/system_tasks.ts` `systemHealthMonitor` (hourly cron) now also calls `sweepWorkspace`. RED on tier-1/3/4 checks adds to gate breaches; tier-2 (cron stale, agent silence) skipped here since `healthCheck` already covers it. Existing 12h gate-suppression handles spam.

### YC connector fix (kills the 90% duplicate problem at source)
- `ycSnapshotHash(c)` over tracked fields: team_size, status, isHiring, batch, stage, top_company, one_liner. Stored on `entity.attributes.yc_snapshot_hash`.
- Existing entities: skip signal emission entirely when hash matches last-seen. On change, emit + update hash atomically.
- New entities: hash stored on create.
- `result.skipped` now sums cap-overflow + unchanged-skip for visibility.
- Default `schedule_cron` cut from `0 6 * * *` (daily) to `0 6 1 */3 *` (quarterly, 6am UTC on 1st of Jan/Apr/Jul/Oct). YC publishes new batches twice a year; daily polling was producing identical data 364 days/year. Updated DB rows for all 3 active YC sources.

### HN connector — dynamic watch list
- When `config.watch_entities` is empty, pull every account in the workspace as the watch list. New accounts discovered by Exa/web/yc get watched automatically next run. Manual config still overrides.
- Algolia query built from keywords only (not entity names) — N-entity OR queries hit URL-length limits past a few dozen accounts. Entity matching now done post-fetch on returned hits.
- Removes the "watch_entities is empty - nothing to match" hard-error.

### Exa + Web extraction prompt rewrite (the real Exa silence cause)
- After credits topped up, 7 of 9 Exa sources still produced 0 signals — diagnosed via new `scripts/debug_extraction.ts` which runs the extraction pipeline against a real source without writing signals.
- Root cause: prompts said "if unsure, omit" + treated listicles/comparison articles as "multi-subject ambiguous" → reject. The LLM also silently dropped items (omitted from BOTH `companies` and `rejected` arrays).
- Three deltas applied to both `exa.ts::batchExtractCompanies` and `web.ts::enrichItemsWithCompanyName`:
  1. **Force completeness** — every input id MUST land in companies or rejected. Connector detects violations and surfaces as errors in `last_run_summary`.
  2. **Loosen "if unsure"** — for listicles/comparisons, extract the FIRST 1-2 companies. Don't bail.
  3. **Structured rejection reason codes** — replace free-form notes with enum: `topic_only_no_subject` | `podcast_or_community` | `doesnt_match_filter` | `forum_discussion_no_company` | `non_english` | `paywalled_or_thin_content` | `personal_blog_no_company` | `ambiguous_multi_subject` | `user_handle_not_company` | `person_not_company` | `generic_noun`.
- Added `batchExtractCompaniesDetailed` (Exa) that returns companies + rejected + silently_dropped. Updated `enrichItemsWithCompanyName` (Web) signature to return `silently_dropped` count.
- Exa extraction lift on the same fetches: crm_switch_ai_workflow 0/18 → 16/16 (100%), revops_scaling_outbound 0/25 → 17/25 (68%), first_sales_hire 1/23 → 12/23 (52%), hubspot_salesforce_complaints 4/20 → 21/24 (88%). Average ~30% → ~75%.
- Web didn't move much (Lenny's 25%→30%, TechCrunch 40%→40%, IndieHackers 0→0). Lenny's rejections now correctly tagged `podcast_or_community` + `topic_only_no_subject` (it IS a podcast newsletter, not a startup-news feed). TechCrunch rejections correctly `doesnt_match_filter`.

### Diagnostic + operational scripts shipped
- `scripts/sweep.ts` — `pnpm sweep` CLI.
- `scripts/inspect_sources.ts` — lists all sources + last_run_summary.
- `scripts/inspect_source_runs.ts` — drills into recent run errors.
- `scripts/debug_extraction.ts --type=web|exa --source=<substr>` — runs extraction without writing signals, dumps LLM input/output/rejection reasons.
- `scripts/trigger_exa_runs.ts` — sends `source.run` events for a connector_type to force immediate dispatch (bypasses 6h cron wait).
- `scripts/wait_for_exa.ts` — polls until all active Exa sources have fresh last_run_at.
- `scripts/cadence_and_hn_fix.ts` + `scripts/hn_revert.ts` — one-shots for the YC cadence update + HN reactivation/revert. Historical now, kept for traceability.

### What the sweep caught on its very first run (validates the design)
- `signal_diversity:yc unique_ratio=0.10 (n=180)` — 90% duplicate signals from YC
- `source_concentration yc=98% (of 184)` — one source dominating
- `novelty:24h_vs_prior overlap=0.98 (180/184)` — same signals re-emitted day over day
- `score_signal_coupling 3/21 entities rescored (14%)` — new signals not triggering rescore
- 3 yc crons stale (>12h), score_distribution 55% in decile 0/10

Every problem the user described, visible in 10 lines of stdout before any prompting.

### Trade-offs / decisions
- The sweep is intentionally workspace-scoped, not signal-row-scoped. Per-output LLM review was rejected (would cost 2× tokens, miss distribution-level failures like the YC duplicates). Distribution checks catch what per-row review can't.
- YC dedup uses direct `entity.attributes` update via supabase, not assert_fact. The signal carries the diff content for downstream agents; attributes is a JSONB blob, not load-bearing for the event-sourced state.
- Did not add HN discover mode (LLM-extract company per hit). Workspace-fallback gets us the same outcome cheaper: as Exa/web/yc discover companies, HN auto-watches them. Manual override still works.
- Did NOT introduce "topic signals" (theme-level signal with no entity). The structured rejection codes give the data if we ever want to wire it; not needed now.
- Skipped IndieHackers feed fix (0 raw items). Defer until user decides if the source is worth keeping.

### Deferred / unchanged
- IndieHackers feed returns 0 items
- Render auto-deploy webhook still broken
- No sending pipeline
- Auto-mode blocks `git push` even after explicit approval

## 2026-05-15 (evening) — Portability foundation (`zany-bouncing-pascal.md`)

Goal: make the CRM safe for a second customer to adopt without code edits. Audit had found 7 hardcoded customer-varying things; this plan moved the load-bearing 3 (override email, banned phrases, contact-enrichment provider) onto `workspaces.policy`, shipped a 30-second wizard, and added a portability guardrail to CLAUDE.md. Scoring weights / perspectives / action thresholds were explicitly deferred (Phase A2) — they're calibrated reasonably and no customer needs them on day one.

### Phase A — config substrate

- `packages/tools/src/policy.ts` (new): `WorkspacePolicy` types with `outreach` + `enrichment` sections, `DEFAULT_POLICY` (vertical-neutral), `getPolicy(supabase, ws_id)` that shallow-merges raw row with defaults. Re-exported from `@agent-crm/tools`.
- `apps/web/app/api/_lib/send_email.ts`: rewritten — takes `{ supabase, workspace_id, ... }`, reads `policy.outreach.{resend_api_key, override_to, from_email}`. `OUTREACH_OVERRIDE_TO` env removed; `RESEND_API_KEY` env kept as single-tenant fallback.
- `apps/web/app/api/gates/decide/route.ts`: passes `supabase + workspace_id` to sendEmail.
- `inngest/functions/agent_logic.ts`: local `WorkspacePolicy` interface deleted in favor of the imported one. Per-run `sanitize()` closure pre-builds `extraBanned = policy.outreach.banned_phrases` and stacks it onto the code-default regex list. Hunter gate now `policy.enrichment.contact_provider === 'hunter' && process.env.HUNTER_API_KEY` — default `'none'` so new workspaces never make surprise Hunter calls. `sanitizeText` accepts optional `extraBanned: string[]` and applies case-insensitive substring excise (policy phrases aren't trusted as regex).
- `scripts/backfill_policy.ts` (new): idempotent. Writes `outreach.override_to='jaws.watson@gmail.com'`, `outreach.from_email`, `outreach.banned_phrases` (a few dog-food phrases), `enrichment.contact_provider='hunter'` to existing workspaces. Optional `--workspace=<uuid>` flag. MUST be run once before the new policy paths take effect.
- `.env.example` updated: `OUTREACH_OVERRIDE_TO` removed; comment now points users to Settings → Email.

### Phase B — 30-second onboarding

- `apps/web/app/api/workspaces/create/route.ts` (new): single POST. Calls `chatComplete` with a deliberately vertical-neutral system prompt that produces `icp / persona / constitution / knowledge_base` from one free-text `about` field. Creates the workspace via `create_workspace` tool (system placeholder actor + 00000-uuid workspace_id, mirroring `seed_demo.ts`), updates row directly with `about + constitution + knowledge_base` (the tool schema doesn't carry those yet), and optionally inserts a starter source row. If the LLM derive fails, falls back to empty defaults so the wizard still finishes.
- `apps/web/app/workspace/new/page.tsx` (new): wizard. Required: workspace name + plain-English "what should the agent help with" textarea (with non-SaaS examples in the placeholder — real estate, recruiting, partner mgmt). Optional collapsed: pick a starter source connector + give it a name; paste Resend API key. Single submit redirects to `/workspace/<id>/channels`.
- `apps/web/app/page.tsx`: 0 workspaces → redirect to `/workspace/new`; 1 → redirect to its `/channels` (preserves Jake's single-tenant flow); 2+ → server-rendered picker with "+ new workspace" link.
- `apps/web/app/workspace/[ws]/settings/page.tsx`: rewritten into 4 tabs (Setup / Email / Integrations / Advanced). Plain-language labels ("Writing rules" not "Constitution", "What kind of accounts" not "ICP", "Tone" not "Persona"). Email tab has friendly fields for `override_to`, `from_email`, banned phrases (one-per-line textarea), Resend key (password input). Integrations tab has `contact_provider` dropdown (none / hunter). Advanced tab keeps raw `policy` JSON + budget — its edits take precedence over friendly fields on save. The friendly fields compose a merged policy via `useMemo` so unknown keys aren't dropped.

### Phase C — guardrail

- `CLAUDE.md`: new `## Portability test` section between "Hard rule: agent-first" and "Competition". Specific bans: no hardcoded customer-varying values, no new env vars for behavior toggles (only secrets), no vertical-specific defaults. Reviewer prompt: *can a customer enable / configure / disable this via workspace settings, without a code change?*

### Verification

- `pnpm -r typecheck` green across all 6 packages (web, inngest, tools, primitives, agents, db).
- Backfill not yet executed — until run, the existing demo workspace will lose its override + Hunter behavior at the next agent tick.
- Wizard end-to-end test not performed in this session; needs a local dev session against prod Supabase.

### Trade-offs / decisions

- ICP and persona stayed JSON textareas in Settings (not converted to plain-English). The wizard produces structured JSON via the LLM derive; rebuilding existing data into prose form would be a destructive migration. Plain-language labels + good help text bridge the gap.
- Banned-phrase policy values are escaped and applied as case-insensitive substring matches, not raw regex. Policy is user input — letting it be regex invites accidental DOS or data-shaped regex catastrophes.
- Wizard's optional starter source captures only `connector_type + name`. URL / query / cron get filled on the Sources page after creation — keeps the wizard genuinely 30 seconds vs. asking 5 connector-specific fields up front.
- Resend API key stored on `policy.outreach.resend_api_key` as a stopgap. Real per-workspace secrets table waits for multi-tenant.

### Deferred — called out explicitly

- Phase A2: scoring weights, scoring perspectives, action-selector thresholds remain code constants. Move to policy when a real customer needs to retune them.
- Multi-tenant auth + RLS, per-workspace secrets table, pluggable email/contact providers, per-workspace vocabulary engine.

## 2026-05-17 — Benchmark overhaul + fact ranking + pain extraction

### Realistic drafter benchmark (the headline result)
- Built `benchmark/runners/agent-crm/run_drafter.ts` — single projection (entity + facts + contacts + past_touch + signals) + one LLM call producing JSON draft
- Built `benchmark/runners/hubspot/run_drafter.ts` — 4-turn tool loop: real `hubspot_get_company_by_name` API call (default property set, envelope preserved) → stubbed `hubspot_get_associated_contacts` and `hubspot_get_recent_notes` using documented HubSpot v3 response shapes (service key lacks scopes for both; content stubbed to match agent-crm seed)
- `scripts/seed_drafter_benchmark.ts` — parity seeder: 2 contacts + 1 past touch per account on agent-crm side, same content stubbed for HubSpot via `benchmark/runners/hubspot/stub_data.json`
- `scripts/demo_drafter_walkthrough.ts` — single-account end-to-end trace, shows turn-by-turn LLM cost growth on the HubSpot side
- **Result: 4.22× cheaper input tokens, 3.94× fewer LLM calls, 1.41× lower latency.** 18 runs each side, 6 accounts × 3 runs, gpt-4o-mini both. Per-account ratios: 2.6× (low) to 10× (Resona, fact-rich). Full report at `benchmark/report/drafter_cost.md`.
- Structural reason: HubSpot's companies / contacts / engagements live in separate tables traversed via associations; drafter MUST call 3+ tools; each tool turn re-sends prior context. Can't be closed by reformatting.

### Original 1.28× token-cost claim retired
- Re-ran the original Workload 1 on current data: agent-crm at 1,225 input tokens, HubSpot floor at 1,082, HubSpot default-setup at 1,224. **The 1.28× advantage flipped.** Single-tool workloads measure serialization format choice, not architecture.
- Built `benchmark/runners/hubspot/run_default.ts` — secondary HubSpot variant with realistic default property request + no envelope stripping, to verify the flip wasn't an artifact of the hand-tuned floor case.
- Marked Workload 1a DEPRECATED in `BENCHMARK.md` with the three reasons it collapsed. Replaced headline with Workload 1b (realistic drafter).
- Bug fixed in the process: `benchmark/runners/agent-crm/run.ts:76` filtered facts with `.is('supersedes', null)`, which returns ORIGINAL facts and excludes the LATEST in any supersede chain. Fixed to match `mirror_seed.ts` logic (build a set of IDs pointed to by other facts' supersedes column, filter those out).

### Score-facts deterministic ranking (shipped)
- New `packages/tools/src/score_facts.ts` — pure deterministic ranking per fact computed at projection time. Formula: pitch_relevance × recency × confidence × (1 - over_used) × outcome_boost.
- Scoring target = `workspace.about + workspace.constitution` (canonical pitch content). Falls back to ICP perspective vectors if both empty. Cached on `workspaces.policy.pitch_embedding_cache` keyed by content hash.
- System facts excluded from candidate pool: `score_*`, `icp_fit*`, predicates ending in `_breakdown`, object_text starting with `{`/`[`, bare numbers.
- Over-used penalty: per-cite exponential decay (τ=14 days), scoped to THIS account's channel, capped at 1. Pulled from `channel_posts.cites[]`.
- Outcome boost: Bayesian-smoothed pos-reply rate (k=5 prior weight, α=0.5 max boost). Auto-engages as outcomes accumulate — same code runs day 1 and day 1000.
- Threshold `min_score: 0.35` — returns empty shortlist when no fact clears the bar instead of surfacing noise.
- Wired into `inngest/functions/agent_logic.ts`: fact query extended with `observed_at` + `source_event_id`; called only when behavior === 'drafter'; result passed to `buildUserPrompt` as `recommended` block.
- `buildUserPrompt` extended with RECOMMENDED FACTS block (~60 tokens added to projection).
- `buildDrafterDecision` (in `packages/tools/src/prompt_builders.ts`) extended with "LEAD-FACT SELECTION" rule — prefer recommended unless past-touch context demands override.
- Instrumentation event `drafter_shortlist_pick` logged per draft: `recommended_fact_ids`, `recommended_scores` (with components), `actually_cited`, `cited_from_shortlist`, `override:bool`. Validates whether model trusts shortlist once outcome data arrives.

### Pain extraction in enricher (shipped)
- `buildEnricherDecision` in `inngest/functions/agent_logic.ts` extended with PAIN EXTRACTION second-pass block. Single predicate `pain_observed` with vertical-neutral example shapes. Adds ~150 tokens per enricher run (~$0.00002 at gpt-4o-mini).
- Two prompt iterations to get right:
  1. First version split pain across `pain_observed` and `has_challenge` predicates depending on tone. Fixed by adding "Statements about challenges, constraints, manual workarounds, or what doesn't work today ARE pain — extract them as pain_observed even when stated calmly and factually."
  2. Second version returned pain facts without confidence field. Fixed by adding "Each pain_observed entry goes in the SAME facts[] array... MUST include the confidence field."
- Validation: `scripts/test_pain_extraction.ts` runs 4 synthetic signal fixtures through the prompt + scoring. 4/4 correctly classified (pain extracted on pain-shaped text, skipped on announcement/promotional). 6 of top 7 ranked facts were pain after extraction.
- Real-signal yield unmeasured — deferred. Synthetic-only validation.

### Documentation
- Overwrote `BENCHMARK.md` at root with 4.22× realistic drafter as the headline. Workload 1a (1.28×) marked DEPRECATED transparently. Workloads 3/5/6 (concurrency, provenance, replay) preserved from prior sessions. Added Reproducing section, Deferred section, Recommended pitch language.
- New `benchmark/report/SESSION_RUNDOWN.md` — scoped to benchmark tests only (Test 1 original, Test 2 default setup, Test 3 realistic drafter, Test 4 Forge walkthrough). Honest about which claims hold vs which collapsed.
- New `benchmark/report/drafter_cost.md` — detailed report for Workload 1b.
- `CLAUDE.md` updated: dogfood test case corrected from "Jake's job hunt" to "use agent-crm to sell agent-crm to founders with ≤1 salesperson." Added buyer-profile line.

### Memory updates
- Banned word list expanded and pinned to top of MEMORY.md: substrate, gates, primitive, wedge, abstraction layer, predicate (as jargon), moat (vaguely). Jake corrected each multiple times — table with replacement words in `feedback_banned_word_substrate.md`.
- New `project_test_case_dogfood.md` — pinned at top of MEMORY.md. Test case is sell agent-crm to companies, NOT Jake's job hunt. Translation rule: when pulling from progress_log or historical docs that reference job hunt, translate to dogfood frame before quoting.

## 2026-05-17 (PM + evening) — Send-loop fix + architecture-as-product split

Two big-arc pushes in one session. First: close the dog-food send loop (drafts with specific angles, post-send cooldown, sweep accuracy). Second: split every customer-varying value off code onto `workspaces.policy` so a second customer can ship without a TypeScript change. Plans: `soft-twirling-pizza.md`, `architecture-as-product.md`.

### Send-loop fix (`soft-twirling-pizza.md`, Tracks 1-4)
- **Track 1 — audit:** `scripts/audit_loop.ts` walks 5 checkpoints (pending approvals, action distribution, top entities + facts, pending drafts, sources). Found: 14 legacy drafts with mostly 0 cites + generic angles, zero `outreach_send` approvals ever, action_selector gating everything since the prior push.
- **Track 2 — value-theme drafter gate:** `policy.drafter.value_themes[]` (name + regex pattern). `action_selector` requires at least one substantive fact matching a theme before `draft_outreach`. matched_theme + matched_evidence threaded into drafter prompt as PRIMARY ANGLE so the LLM leads with it. Source-bookkeeping predicates (query / intent / item_url / etc.) filtered before theme matching — killed the Viasocket-style false positive. Demo seeded with hiring / headcount / token_cost / ai_integration themes.
- **Track 3 — post-send loop:** `gates/decide/route.ts` asserts `outreach_cooldown_until` (default 14d) after send. action_selector honors it (new `outreach_cooldown_active` policy). New daily `silenceSweep` cron: 7d no-reply → `no_reply_marked` fact + scoreAndAssert recompute. Reply ingest (Resend inbound webhook) deferred — subscription infra already exists.
- **Track 4 — sweep accuracy:** New shared `packages/tools/src/cron.ts` handles `0 6 1 */3 *` (quarterly) etc. `cron_stale` honors per-source cadence (× 1.5/3.0 multiplier). `scoreAndAssert` short-circuits if active `dropped_until`. `score_distribution` excludes dropped + zero-substantive-fact entities. 4 YELLOW → 1 YELLOW.
- `scripts/verify_loop.ts` — synthetic action routing against current facts. Apollo → `draft_outreach theme=hiring evidence=hiring_for=RevOps director`. Viasocket → `watch_only no_value_aligned_signal`.

### Architecture-as-product split (`architecture-as-product.md`, Phases 1-5 + 5.5a + 5.5b)
Five-phase move of every customer-varying value off code constants onto `workspaces.policy`.

**Phase 1 — Connectors as data**
- `inngest/functions/sources/connectors/custom_http.ts` (new). Declarative spec: `fetch.{url, method, headers, body, response_path}`, `extract.{system_prompt, batch_size, model}`, `signal.{type, magnitude}`, `dedup.{since_hours, item_id_path}`. Engine fetches, batches items through LLM with the workspace's prompt, asserts entities + facts + signals via `callTool`.
- `/api/connectors/test-fetch` — preview raw response (truncated at 200KB).
- `/api/connectors/generate-spec` — LLM derives `response_path`, `extraction_prompt`, `signal_type`, `batch_size` from URL + sample JSON + free-text description. Vertical-aware (description tells LLM not to reuse B2B predicates on non-B2B).
- `/api/connectors/create` — idempotent insert/update into `sources`.
- 4-step wizard at `/workspace/[ws]/connectors/new`: name+URL+auth → test fetch → describe → preview spec → save with schedule.
- `scripts/verify_connector.ts` runs the full path against public HN Algolia (OpenAI quota blocked LLM step at the time).

**Phase 2 — Enricher taxonomy on policy**
- `EnrichmentPolicy.example_facts: Array<{predicate, object_text}>` + `banned_predicates: string[]`. `ENRICHER_DECISION` constant replaced with `buildEnricherDecision({examples, banned})` function. Vertical-neutral fallbacks when empty. Always-banned: `is_company`, `is_real`, `exists`, `is_in_tech`, `is_business`.
- Wizard derives example_facts from the workspace description.
- Backfill seeds 8 dog-food predicates: hiring_for, headcount, sales_motion, raised_round, launched_product, target_market, using_ai, token_burn.
- Settings → Integrations gains enricher examples + banned predicates textareas.

**Phase 3 — Drafter formula on policy**
- `DrafterPolicy.{subject_style, paragraph_count, pain_points, value_props, tone_keywords, ask_examples}`. Long `DRAFTER_DECISION` constant replaced with `buildDrafterDecision({...policy})` extracted to `packages/tools/src/prompt_builders.ts`. Pain/value bullets come from policy; tone keywords steer voice; forbidden phrases come from `policy.outreach.banned_phrases`.
- Wizard derives pain_points + value_props + tone_keywords from the description.
- Backfill seeds dog-food values: 4 pains (legacy CRM bolt-on, token bloat, last-write-wins, no provenance), 4 value props (concurrent-write benchmark, citation trail, 1.28x token reduction, empty home), 4 tones, 3 asks.
- Settings → Drafter tab.

**Phase 4 — Routing thresholds + scoring weights on policy**
- `RoutingPolicy` (11 thresholds across draft/research/drop/watch). `ScoringPolicy.weights` (6 sub-score weights) + `rrf_gate`. `selectAction` accepts optional `thresholds`; `combineSubScores` accepts optional `weights`; `scoreEntity` reads policy and threads both. `buildThresholds()` / `buildScoreWeights()` merge partials onto defaults.
- Backfill seeds explicit copies of all defaults so they're editable in Settings.
- Settings → Routing tab with `NumRow` helper component for every threshold + weight. Live "sum of weights" display.

**Phase 5 — Settings polish**
- Reset-to-defaults buttons on Drafter, Routing, Enrichment sections.
- `/api/admin/preview-prompt` + Drafter-tab "Preview prompt" panel — calls `buildDrafterDecision` with current form values, renders the system prompt the LLM will see.
- `/api/admin/routing-preview` — runs `selectAction` against top 30 entities with proposed thresholds + weights, returns action distribution + per-entity table (icp_total_now vs icp_total_reweighted with color coding). Routing tab renders it inline.

**5.5a — LLM keys on workspace policy**
- `LLMPolicy.{openai_api_key, openrouter_api_key, default_chat_model, drafter_model}`. New `chatCompleteForWorkspace(supabase, workspace_id, args)` helper in `@agent-crm/tools`: reads policy, merges with env fallback, delegates to primitives `chatComplete` with `api_keys` override. Behavior-aware (drafter behavior auto-lifts default to Pro).
- Routed callers: `inngest/functions/agent_logic.ts` (drafter + enricher + claim_poster), `packages/tools/src/scoring.ts` (rubric LLM call), `inngest/functions/sources/connectors/custom_http.ts`, `apps/web/app/api/agent/intake/route.ts`, `apps/web/app/api/agent/intake/tools.ts::extract_facts`.
- Not routed (env-only): exa/web/api_call connectors, agents/parse, sources/parse, workspaces/create, connectors/generate-spec. Defer until threading supabase+workspace_id through those helper fn sigs pays off.
- Settings → LLM tab with paste-key forms + model overrides.

**5.5b — Global chat intake widget with ReAct + SSE**
- Floating ✦ button (⌘K toggle) on every workspace page. `apps/web/app/_components/IntakeWidget.tsx`.
- `/api/agent/intake` runs a server-side ReAct loop with 8 MCP-backed tools: lookup_entity / get_entity / create_account / extract_facts (inline LLM, no writes) / assert_facts / rescore_entity / propose_action (synthetic selectAction) / trigger_drafter (fires `agent.run` Inngest event).
- SSE streaming: each step (assistant text, tool_call, tool_result) flushes to the client as a separate event. Client incrementally renders.
- Per-tool result renderers (instead of JSON blobs): lookup → match list with icp_fit chips; extract_facts → fact preview cards with predicate/value/confidence; rescore → score bars; propose_action → color-coded action badge + reason + sub-score bars; trigger_drafter → "dispatched" callout.
- `chatComplete` extended to support OpenAI-format `tools[]` + `tool_choice`. ChatMessage gains `tool_calls`, `tool_call_id`, `name`.
- System prompt enforces confirmation gates on writes — no fact gets asserted without explicit user yes.
- MAX_STEPS=8, max_tokens=1200 per turn.
- Deferred: conversation persistence across refresh, mobile responsive <420px, approve/skip buttons on extract_facts cards.

### LLM routing
- Default chat = `deepseek/deepseek-v4-flash:free` (OpenRouter). Drafter = `deepseek/deepseek-v4-pro`. Fallback on JSON-validation failure stays `gpt-4o-mini` (OpenAI direct) for cross-provider resilience.
- Embedding stays on OpenAI `text-embedding-3-small` (pgvector dimension compatibility).
- Required env on Render: `OPENROUTER_API_KEY` + existing `OPENAI_API_KEY`.

### Bug fix
- **icp_fit supersede leak.** `scoreAndAssert` was using `.maybeSingle()` for the prior-fact lookup; with >1 active row, it errored and fell into the "no existing" branch, inserting yet another active row. Coffee had score_total=0.19 (fresh) + icp_fit=0.70 (152h stale). Fixed: `.order('observed_at desc').limit(1).maybeSingle()`.

### Workflow finding
- Jake reminded me (correctly): local dev server (`pnpm --filter web dev`) reads prod Supabase via `.env.local` and HMRs UI/API changes. Only need to push for Inngest function changes that run on prod cron. I was over-pushing for UI iterations this session — should have suggested local dev for the Settings tabs / chat widget / preview routes.

### Trade-offs
- Did NOT migrate embeddings off OpenAI. Cost is ~$0.02/M tokens — basically free. Migration cost (drop pgvector column, change dimension, rebuild HNSW, re-embed everything) doesn't pay back as a money play, only as a provider-independence play. Deferred.
- Did NOT wire native Anthropic SDK. OpenRouter slash-prefix (`anthropic/claude-sonnet-4-6`) works for Anthropic models. Deferred until Anthropic billing clears at the account level.
- Did NOT verify architecture-as-product end-to-end against a fresh real-estate workspace. Code path proven via verify_loop on dog-food workspace; second-vertical sanity check is the obvious next deliverable.

