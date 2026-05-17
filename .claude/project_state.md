# Project State

Last Update: 2026-05-17 EDT (late evening — architecture-as-product split)

## Direction

Agent-first CRM. Primary user is the agent; humans intervene only at exception approvals. Wedge is the abstraction layer above commodity DB (Postgres + pgvector + RLS), not the DB itself.

**Architecture is the moat.** Events + facts + provenance + replay + concurrency. Knowledge bases, drafter formula, NL config, constitution field, meta-agent routing — all commodities. Never pitch a surface feature as defensible.

**v0 strategy:** Build foundation + abstraction layer, prove it's measurably better for agent workloads than HubSpot via a benchmark suite, then pick a use case once the architecture is validated. **Dogfood test case: use agent-crm to sell agent-crm itself to founders running with ≤1 salesperson** (CLAUDE.md updated 2026-05-17, supersedes the prior "Jake's job hunt" framing).

## Stack confirmed

- Supabase (Postgres + pgvector) — hosted
- Inngest cloud as durable runtime — vault-backed pg_net trigger publishes signals/facts/approvals to webhook
- Next.js 15 viewer on Render (Free tier, kept warm by cron-job.org ping at /api/health)
- OpenAI for agent calls (Anthropic API blocked at the account level — see CODING.md). OpenRouter routing via model id containing `/`
- Default LLM = OpenAI; do NOT introduce `@anthropic-ai/sdk` calls
- **Dev workflow**: `pnpm --filter web dev` against prod Supabase via .env.local — push only for prod cron / customer-facing changes

## Hard rules (in CLAUDE.md + memory)

- **Agent-first or it doesn't ship.** Banned: pipeline views, sortable tables, kanban, batch ops, in-app feeds. Allowed human surfaces: approval queue, audit (verify agent state), config.
- **No new agents.** Closed set: claim_poster, drafter, enricher. Solve via tools, prompts, post-processors.
- **Real, scalable solutions.** No app-side fetch hacks for things that belong in the DB.
- **Not sending emails.** Drafts stay in Inbox; human still copy-pastes.
- **Banned words in any output to Jake:** substrate, gates, primitive, wedge, abstraction layer, predicate (as jargon), moat (vaguely). Use plain alternatives.

## v0 Benchmark results (current)

**Headline (use this in pitches):**
- **Workload 1b — Realistic drafter task: 4.22× cheaper tokens, 3.94× fewer LLM calls, 1.41× lower latency.** Real measurement, 18 runs each side. Structural — HubSpot can't close it by reformatting because the multi-call requirement is intrinsic to their data model.

**Categorical capability gaps (still valid from prior sessions):**
- **Workload 3 — Concurrency:** HubSpot loses 96% of 50 concurrent writes silently; agent-crm loses 0%
- **Workload 5 — Provenance:** agent-crm walks fact → event → actor → prompt chain in one join; HubSpot has 0 hops past the prose blob
- **Workload 6 — Replay:** agent-crm reconstructs full state at any past timestamp via one RPC; HubSpot has no equivalent

**Dead claim (do not cite):**
- ~~Workload 1a — Single-decision token cost 1.28×~~ — collapsed on re-validation. Numbers flipped on current data; single-tool workloads measure serialization format, not architecture. Marked DEPRECATED in `BENCHMARK.md`.

**Deferred:**
- Hallucination rate per draft (n=1 anecdote suggests HubSpot fabricates more, but no LLM-judge harness to measure systematically)
- Pain-extraction yield on real production signals (only validated on synthetic fixtures)

Full report: `BENCHMARK.md` at root. Detailed drafter result: `benchmark/report/drafter_cost.md`.

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
- All operational rejections are `decision` channel posts, never approvals. Approval queue reserved for irreversible human approvals (currently unused — no sending pipeline).
- Decision posts on every draft + enrichment (full audit chain)
- Outcome posts when approvals decided
- Fact-triggered subscriptions architecture in place (subscriptions.fact_filter column + match_fact RPC + match-fact Inngest function); no fact-triggered subs created yet but infra is live

### Architecture-as-product split (2026-05-17 PM/evening) — every customer-varying value moved off code, onto workspace.policy
- **Phase 1 — Connectors as data.** New `custom_http` connector engine in `inngest/functions/sources/connectors/custom_http.ts`: declarative fetch+LLM-extract spec stored in `sources.config`. Three API routes: `/api/connectors/test-fetch` (preview raw response), `/api/connectors/generate-spec` (LLM derives spec from URL + sample + free-text description), `/api/connectors/create` (idempotent save). 4-step wizard at `/workspace/[ws]/connectors/new`. New verticals add data sources by URL + description, no TypeScript.
- **Phase 2 — Enricher taxonomy on policy.** `policy.enrichment.example_facts[]` + `banned_predicates[]`. Hardcoded `ENRICHER_DECISION` constant replaced with `buildEnricherDecision({examples, banned})` function. Vertical-neutral fallback when policy empty. Wizard auto-derives example_facts from the customer's free-text description; backfill seeds 8 dog-food predicates onto the demo workspace.
- **Phase 3 — Drafter formula on policy.** `policy.drafter.{subject_style, paragraph_count, pain_points, value_props, tone_keywords, ask_examples}`. Long `DRAFTER_DECISION` constant (B2B-specific pain bullets, "AI-native CRM" forbidden-phrase list) replaced with `buildDrafterDecision({...policy})` extracted to `packages/tools/src/prompt_builders.ts`. Wizard derives drafter formula from the description; backfill seeds dog-food values.
- **Phase 4 — Routing thresholds + scoring weights on policy.** `policy.routing` (11 thresholds across draft/research/drop/watch) + `policy.scoring.weights` + `rrf_gate`. `selectAction` accepts optional `thresholds`; `combineSubScores` accepts optional `weights`; `scoreEntity` reads policy and threads both. `buildThresholds()` / `buildScoreWeights()` merge partial policies onto defaults.
- **Phase 5 — Settings polish.** Reset-to-defaults buttons (Drafter / Routing / Enrichment). `/api/admin/preview-prompt` + Drafter-tab Preview panel showing the rendered system prompt. `/api/admin/routing-preview` runs `selectAction` against top 30 entities with proposed thresholds + weights, returns action distribution + per-entity table; Routing tab renders it inline.
- **5.5a — LLM keys on workspace policy.** `policy.llm.{openai_api_key, openrouter_api_key, default_chat_model, drafter_model}`. New `chatCompleteForWorkspace()` helper in tools merges policy with env fallback. Routed through agent_logic (drafter + enricher), scoring, intake route, custom_http connector. Settings → LLM tab with paste-key forms. Embedding stays on env-OpenAI (pgvector compatibility).
- **5.5b — Global chat intake widget with ReAct + SSE.** Floating ✦ button (⌘K toggle) on every workspace page. `/api/agent/intake` runs a server-side ReAct loop with 8 MCP-backed tools (lookup_entity / get_entity / create_account / extract_facts / assert_facts / rescore_entity / propose_action / trigger_drafter). SSE-streams each step to the client. Per-tool result renderers (match list, fact cards, score bars, action badge) instead of JSON blobs.
- Settings page tab structure now: Setup / Email / Drafter / Routing / Integrations / LLM / Advanced. Advanced JSON still wins on save when it edits keys the friendly tabs don't manage.

After this push, a fresh workspace can ship to a second customer with zero code change: wizard derives ICP/persona/constitution/enricher_examples/drafter_formula from one free-text description, customer pastes their own LLM keys, optionally tunes routing/scoring in Settings, wires their own connectors via the URL+description wizard.

### Send-loop fixes (2026-05-17 PM)
- **Value-theme drafter gate.** `policy.drafter.value_themes[]` = regex patterns. `action_selector` requires at least one substantive fact matching a theme before `draft_outreach` fires — otherwise `watch_only / no_value_aligned_signal`. matched_theme + matched_evidence threaded into drafter prompt as PRIMARY ANGLE. Stops generic "saw you're growing" drafts; demo seeded with hiring / headcount / token_cost / ai_integration themes.
- **Post-send loop wired.** Approve-and-send asserts `outreach_cooldown_until` (default 14d, configurable). action_selector honors cooldown via new `outreach_cooldown_active` policy. New daily `silenceSweep` cron: 7d no-reply → `no_reply_marked` fact + score recompute. (Reply ingest itself deferred — Resend inbound webhook → `inbound_email` fact is the next step.)
- **Sweep accuracy.** `cron_stale` now reads each source's `schedule_cron` (quarterly YC sources stop tripping the 24h threshold). `scoreAndAssert` short-circuits if active `dropped_until`. `score_distribution` excludes dropped + zero-substantive-fact entities. Output went 4 YELLOW → 1 YELLOW; remaining is real.
- **icp_fit supersede leak fixed.** `scoreAndAssert` was using `.maybeSingle()` for the prior-fact lookup; with >1 active row, it errored and silently inserted yet another active row, compounding the leak. Changed to `.order().limit(1).maybeSingle()`.

### LLM routing (2026-05-17 PM)
- Default chat model = `deepseek/deepseek-v4-flash:free` (OpenRouter). Drafter = `deepseek/deepseek-v4-pro`. Fallback on JSON-validation failure stays `gpt-4o-mini` (OpenAI direct) — cross-provider resilience.
- Embedding still hits OpenAI `text-embedding-3-small` (pgvector-stored vectors are dimension-locked).
- Required env: `OPENROUTER_API_KEY` on Render (in addition to existing `OPENAI_API_KEY`).
- Per-workspace key paste in Settings → LLM tab wins over env when set.

### Fact ranking + pain extraction (2026-05-17)
- New `packages/tools/src/score_facts.ts` — deterministic per-fact ranking computed at projection time. Formula: cosine(fact, pitch_content) × recency × confidence × (1 - over_used) × outcome_boost. Top-K shortlist (default 3) surfaced to drafter as `recommended` block in the projection. Threshold `min_score: 0.35` returns empty shortlist when nothing clears the bar (better than surfacing noise).
- Scoring target = `workspace.about + workspace.constitution` (canonical pitch content). Falls back to ICP perspective vectors if both empty. System facts (`score_*`, `icp_fit*`, JSON-shaped object_text, bare numbers) excluded from candidate pool.
- Outcome boost via Bayesian smoothing — engages automatically as outcomes accumulate. Same code runs day 1 (no data → boost ≈ 1) and day 1000 (outcomes dominate the prior).
- Drafter system prompt extended with "LEAD-FACT SELECTION" rule: prefer recommended facts unless past_touch context demands override.
- Instrumentation event `drafter_shortlist_pick` logged per draft: recommended_fact_ids + actually_cited + override:true/false + score components. Validates whether model trusts shortlist once outcome data arrives.
- Enricher prompt extended with PAIN EXTRACTION second pass: extracts `pain_observed` facts (with confidence) alongside demographic facts. Vertical-neutral example shapes. Validated on 4 synthetic signals (4/4 correct classification). Real-signal yield unmeasured.

### Realistic drafter benchmark (2026-05-17)
- `benchmark/runners/agent-crm/run_drafter.ts` — single projection (entity + facts + contacts + past_touch + signals) + one LLM call
- `benchmark/runners/hubspot/run_drafter.ts` — 4-turn tool loop: get_company (real HubSpot API) → get_associated_contacts (stubbed, documented v3 shape) → get_recent_notes (stubbed) → emit draft
- `scripts/seed_drafter_benchmark.ts` — parity seeder (2 contacts + 1 past touch per account on agent-crm side; same content stubbed for HubSpot since service key lacks contacts/engagements scope)
- `scripts/demo_drafter_walkthrough.ts` — single-account end-to-end trace showing turn-by-turn LLM cost growth on the HubSpot side
- Headline result: 4.22× cheaper tokens, 3.94× fewer LLM calls, 1.41× lower latency. Full details in `BENCHMARK.md` and `benchmark/report/drafter_cost.md`.
- Bug fixed: `benchmark/runners/agent-crm/run.ts:76` — `.is('supersedes', null)` returns ORIGINAL facts, not LATEST. Replaced with mirror_seed's correct supersede-dedup logic.
- `benchmark/runners/hubspot/run_default.ts` — secondary HubSpot variant (default property set, envelope preserved) for the single-decision workload. Confirmed parity with agent-crm on current data — supports the "single-tool benchmarks measure format, not architecture" finding.

### Portability foundation (2026-05-15 PM)
- Customer-varying values moved to `workspaces.policy` jsonb. New `packages/tools/src/policy.ts` exposes `WorkspacePolicy` types, `DEFAULT_POLICY`, `getPolicy(supabase, ws_id)`.
- Outreach config (`override_to`, `from_email`, `banned_phrases`, `resend_api_key`) and enrichment toggle (`contact_provider: 'none' | 'hunter'`) live on policy — no more env vars for behavior toggles.
- `sendEmail()` rewritten to take supabase + workspace_id, reads policy at send time. `OUTREACH_OVERRIDE_TO` env removed; `RESEND_API_KEY` env kept as single-tenant fallback.
- agent_logic.ts: workspace-scoped `sanitize()` closure stacks `policy.outreach.banned_phrases` on top of code defaults. Hunter check becomes `policy.enrichment.contact_provider === 'hunter' && HUNTER_API_KEY` — default `'none'` means new workspaces don't make surprise Hunter calls.
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
- drafter_shortlist_pick event emitted per draft (recommended vs actually cited + override flag + score components)
- token_summary MCP tool + /api/admin/health exposes tokens_24h + tokens_7d, cache_rate, action_distribution (draft/watch/research/drop/continue counts), tokens_per_drafted_touch, tokens_per_scored_account
- Per-source signals_7d in `sources.last_run_summary` for yield tracking
- No pricing tables (per user direction): raw token counts only
- **Sweep** (`pnpm sweep`): 10 deterministic SQL checks across 4 tiers (signal diversity / silence / cost / scoring health) with RED/YELLOW/GREEN output and deterministic ACTION templates. Same `sweepWorkspace()` function in `@agent-crm/tools` is called from:
  - SessionStart hook in `.claude/settings.json` — red flags surface at the top of every session automatically
  - hourly `systemHealthMonitor` cron — RED on tier-1/3/4 checks opens an approval (with 12h cooldown). Tier 2 (cron staleness, agent silence) skipped here to avoid double-alerts with existing `healthCheck`
- Debug tools: `scripts/debug_extraction.ts --type=exa|web` runs the extraction pipeline against a real source without writing signals, dumps LLM input + output + rejection reasons. `scripts/inspect_sources.ts` lists all sources + last_run_summary. `scripts/trigger_exa_runs.ts` forces immediate dispatch of `source.run` events for a given connector_type
- Diagnostic scripts fixed against real schema (events.created_at not .ts; signal_source under structured_tags; channel_posts joined via channels; gates.decided_at not .status)
- check_stuck.ts, audit_state.ts, audit_subscriptions.ts, sample_recent_posts.ts, check_processing.ts, probe_matcher.ts, dismiss_operational_gates.ts — operator diagnostics

## Known issues (deferred)

- IndieHackers RSS feed returns 0 raw items (feed URL or content-type changed). Lenny's and TechCrunch parse fine.
- RSS false-positive entity creation: tightened again in 2026-05-15 prompt push, still imperfect
- Render auto-deploy webhook broken — user reconnecting GitHub App; manual redeploys for now
- A handful of accounts have `.example` placeholder domains and can't get Hunter contacts
- No sending pipeline — drafts stay in Inbox forever; human copy-pastes manually
- Auto-mode classifier blocks `git push origin main` and bulk DB updates even after explicit approval; user has to run those manually
- Workspace.constitution + about embedding gives one noise fact (`focuses_on: product development`) score of 0.383 — close to the top pain fact (0.392). Tuning issue, not architectural. Address via tighter `about` text or predicate-aware boost when more outcome data accumulates.
- **End-to-end verification of architecture-as-product against a fresh real-estate workspace is deferred** — code path proven via verify_loop on dog-food workspace, but no second-vertical sanity check yet. Open question: do the wizard-derived `example_facts` and drafter `pain_points` for a non-B2B vertical actually produce sensible drafts?
- **Reply ingest** for the post-send loop is not wired. `outreach_cooldown_until` + `silenceSweep` cron are live; an `inbound_email` Resend webhook → fact assertion would close the loop. Subscription infra (fact_filter on `inbound_email` predicate) is already in place.
- **Embedding doesn't read `policy.llm.openai_api_key` yet** — only chat does. Per-workspace embedding keys would need a thin wrapper around `embed()`; deferred until a customer asks.
- **Persistence + mobile responsiveness on the intake widget.** Conversation resets on refresh; panel is fixed-width 440px so <460px viewports break. Both deferred.
- **Native Anthropic SDK.** Anthropic models route via OpenRouter slash-prefix (`anthropic/claude-sonnet-4-6`); no direct API integration. Deferred until Anthropic billing clears.
- **Per-workspace secrets table.** API keys live on `workspaces.policy` as a stopgap; a real `workspace_secrets` table with envelope encryption is the long-term move.
- **Connector marketplace / sharing across workspaces.** Today connectors are per-workspace rows in `sources`. No way to share a spec with another customer.

## Plan File

Most recent: `architecture-as-product.md` — five-phase split moving every customer-varying value off code onto `workspaces.policy`. Phases 1-5 + 5.5a + 5.5b all shipped. Verification end-to-end against a real-estate workspace deferred.

Earlier today: `soft-twirling-pizza.md` — five tracks (audit → value-theme drafter gate → post-send loop → sweep accuracy → end-to-end verify). Tracks 1-4 shipped; Track 5 (verify in prod) deferred to user.

Prior: `zany-bouncing-pascal.md` — Portability foundation. Phase A (policy.ts + send_email + agent_logic + backfill_policy.ts), Phase B (wizard + /api/workspaces/create + home routing + tabbed Settings), Phase C (Portability test in CLAUDE.md). Shipped end-to-end; backfill must be run once.

Older: `quirky-mapping-pinwheel.md` (Scoring v2 + UI overhaul); `mellow-finding-noodle.md` (drafter consolidation, fact-triggered subs, ICP rescore, token obs).

2026-05-17 daytime benchmark work: no formal plan — design generated inline (realistic drafter benchmark + score_facts ranking + pain extraction + BENCHMARK.md overwrite).

## Open Questions

- Reactions / outcomes UI design (outcome post exists per approval decision, but no aggregated "outcomes I care about" view)
- Multi-tenant embedding strategy (defer to design partner)
- Memory hierarchy (L1 prompt → L4 cold) — design vs let it emerge from cost pressure
- Where Sim/MCP plugs in as the action layer
- pgvector HNSW quality at >100k vectors per index (test before assuming)
- TAM at the sharp end (ops teams >1K autonomous touches/month, ~2K companies)
- Per-tenant Hunter quota tracking (single workspace today)
- Pain-extraction yield on real production signals (only validated on synthetic fixtures so far)
- Hallucination rate per draft on HubSpot vs agent-crm (one anecdote, needs an LLM-judge harness to measure)
