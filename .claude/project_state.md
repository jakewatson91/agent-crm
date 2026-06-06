# Project State

Last Update: 2026-06-05

> Open items + reference only. Dated session history → `progress_log.md`. Current system map → `architecture.md`. Cross-project lessons → agent_memory daily log.

## Next session — read first
See `.claude/backlog.md`. North star = more agent autonomy + phone-actionable approvals (Jake wants the system running itself and pinging him to accept/reject from his phone, including dial-now/snooze for call moments).

## Direction

Agent-first CRM. Primary user is the agent; humans intervene only at exception approvals. Wedge is the abstraction layer above commodity DB (Postgres + pgvector + RLS), not the DB itself.

**Architecture is the moat.** Events + facts + provenance + replay + concurrency. Knowledge bases, drafter formula, NL config, constitution field, meta-agent routing — all commodities. Never pitch a surface feature as defensible.

**v0 strategy:** Build foundation + abstraction layer, prove it's measurably better for agent workloads than HubSpot via a benchmark suite, then pick a use case once the architecture is validated. **Dogfood test case: use agent-crm to sell agent-crm itself to founders running with ≤1 salesperson** (CLAUDE.md updated 2026-05-17, supersedes the prior "Jake's job hunt" framing).

## Stack confirmed

- Supabase (Postgres + pgvector) — hosted
- Inngest cloud as durable runtime — vault-backed pg_net trigger publishes signals/facts/approvals to webhook
- Next.js 15 viewer on Render (Free tier, kept warm by cron-job.org ping at /api/health)
- **LLM via Vercel AI SDK** (as of 2026-05-27). `deepseek/<model>` → DeepSeek direct (`DEEPSEEK_API_KEY`); any other `<vendor>/<model>` → Vercel AI Gateway (`AI_GATEWAY_API_KEY`). Default = DeepSeek (flash bulk / pro drafter). OpenRouter and direct-OpenAI chat paths removed. Do NOT reintroduce per-provider fetch code or `@anthropic-ai/sdk` calls — Anthropic is reachable through the gateway by config. See `[[project_llm_routing_ai_sdk_gateway]]`.
- Embeddings stay OpenAI `text-embedding-3-small` (DeepSeek has no embeddings endpoint; pgvector dimension-locked).
- **Dev workflow**: `pnpm --filter web dev` against prod Supabase via .env.local — push only for prod cron / customer-facing changes. Dev runs turbopack (`next dev --turbopack`); **build runs webpack** (`next build`, dropped `--turbopack` 2026-05-31 — turbopack couldn't build the inngest module graph; see build note below). Cold first-route compile ~7-10s, subsequent route compiles 200ms-3s, warm tab navigations 150-500ms. If you hit `ENOENT: ... _buildManifest.js.tmp` errors, kill all `next dev` processes and `rm -rf apps/web/.next apps/web/.turbo` — usually a race between two parallel dev servers. **Perf regressions recur** — do not break these three rules: (1) `auth.ts:getUser()` uses `getSession()` (no remote call; middleware already validated); (2) all read API routes are wrapped in `unstable_cache`; (3) SWR has `revalidateOnFocus: false`.
- **Turbopack `.js` → `.ts` extension-alias is broken in Next 15.5.18 for workspace packages** (despite `turbopack.resolveExtensions` config). Symptom: any route consuming `@agent-crm/primitives` or `@agent-crm/tools` 500s with `Module not found: Can't resolve './act.js'`. Fix shipped: every relative `./foo.js` import inside `packages/primitives/src/` and `packages/tools/src/` rewritten to `./foo.ts`. Turbopack accepts `.ts` directly; tsx accepts both. New files added to these packages MUST use `.ts` extensions in their imports.
- **Every new `@agent-crm/*` workspace package must be added to `transpilePackages` in `apps/web/next.config.mjs`.** Turbopack only applies `resolveExtensions` to listed packages. Caught when `@agent-crm/composio` was added but missed from the list: every page in the app 500'd with `Module not found: Can't resolve './scope.js'` even though the file was `.ts` — the package was treated as a non-transpiled library. Current list: primitives, tools, agents, db, inngest, composio.
- **Prod build is fragile — validate `next build` locally before any deploy (2026-05-31).** The web app bundles the inngest functions (`app/api/inngest/route.ts` → `inngest/functions/index.ts`), whose `.ts` sources use explicit `./foo.js` specifiers. Turbopack's `resolveExtensions` only resolves *extensionless* imports, not explicit `.js`→`.ts`, so `next build --turbopack` died with 62 Module-not-found errors. Fix in `apps/web/next.config.mjs`: build with webpack + `webpack.resolve.extensionAlias { '.js': ['.ts','.tsx','.js'] }`. Separately, `next build`'s tsc/eslint phase rejects the *packages'* explicit `./foo.ts` imports (TS5097) **and hung 88 min in-sandbox**, so `typescript.ignoreBuildErrors` + `eslint.ignoreDuringBuilds` are set (types still checked via each package's own `tsc --noEmit`). Net: the `.ts`-rewrite that fixed turbopack dev is what breaks `next build`'s typecheck.

## Hard rules (in CLAUDE.md + memory)

- **Agent-first or it doesn't ship.** Banned: pipeline views, sortable tables, kanban, batch ops, in-app feeds. Allowed human surfaces: approval queue, audit (verify agent state), config.
- **No new agents.** Closed set: claim_poster, drafter, enricher. Solve via tools, prompts, post-processors.
- **Real, scalable solutions.** No app-side fetch hacks for things that belong in the DB.
- **Not sending emails.** Drafts stay in Inbox; human still copy-pastes.
- **Banned words in any output to Jake:** substrate, gates, primitive, wedge, abstraction layer, predicate (as jargon), moat (vaguely). Use plain alternatives.

## v1 Benchmark results (current — supersedes v0 token claims)

**Headline (use this in pitches):**
- **Production agent-crm is 12% cheaper than Twenty.com, 2-7× cheaper than HubSpot, and 5-16× cheaper than Day.ai and Attio** on agent token cost across 3 workloads (draft / brief / score). Mean cost: $0.000475/action. 702 runs total, 5 platforms, all receipts saved. `benchmark/v1/WRITEUP.md`.
- Architectural gap is structural — bundled-read CRMs (agent-crm, Twenty) crush tool-loop CRMs (HubSpot, Day.ai, Attio) by 2-9× regardless of HubSpot's field selection. The tool-loop overhead can't be optimized away by the client.
- Production text format (the actual format used in `inngest/functions/agent_logic.ts: buildUserPrompt`) is 14% cheaper than the flat-JSON projection v1 originally measured, because dense text format has less structural overhead than nested JSON.

**v0 Workload 1b superseded:** ~~4.22× cheaper drafter tokens~~ — measured against stubbed HubSpot data on gpt-4o-mini. v1 measures real HubSpot APIs on production DeepSeek-reasoner and produces honest ratios across 3 workloads. v1 numbers are what to cite going forward.

**Categorical capability gaps (still valid from prior sessions):**
- **Workload 3 — Concurrency:** HubSpot loses 96% of 50 concurrent writes silently; agent-crm loses 0%
- **Workload 5 — Provenance:** agent-crm walks fact → event → actor → prompt chain in one join; HubSpot has 0 hops past the prose blob
- **Workload 6 — Replay:** agent-crm reconstructs full state at any past timestamp via one RPC; HubSpot has no equivalent

**Dead claim (do not cite):**
- ~~Workload 1a — Single-decision token cost 1.28×~~ — collapsed on re-validation. Numbers flipped on current data; single-tool workloads measure serialization format, not architecture. Marked DEPRECATED in `BENCHMARK.md`.
- ~~Workload 1b — 4.22× cheaper drafter tokens~~ — superseded by v1 (see above).

**Deferred (still open):**
- Hallucination rate per draft (n=1 anecdote suggests HubSpot fabricates more, but no LLM-judge harness to measure systematically)
- Pain-extraction yield on real production signals (only validated on synthetic fixtures)
- Quality eval at N=30+ blind-scored outputs per platform on v1 dataset (v1 punted this; sample inspection showed comparable quality, no rigorous test)

Full reports: `benchmark/v1/WRITEUP.md` (current), `BENCHMARK.md` at root (v0, retained for history), `benchmark/report/drafter_cost.md` (v0 drafter detail).

## What's Built

Full current system map moved to `architecture.md`.

## Known issues (deferred)

- **`unstable_cache` invalidation not wired to mutations.** Gates, feed, entities, and health are cached server-side (tags: 'gates', 'feed', 'entities', 'health'). Mutation routes (e.g. `gates/decide`) must call `revalidateTag('gates')` after writes or users will see stale data for up to the TTL (15-60s). Add these as the write paths are touched.
- IndieHackers RSS feed returns 0 raw items (feed URL or content-type changed). Lenny's and TechCrunch parse fine.
- RSS false-positive entity creation: tightened again in 2026-05-15 prompt push, still imperfect
- Render free-tier host went fully stale 2026-06-05 (slept + ran old pre-AI-SDK code); fixed by merging llm-ai-sdk-registry → main. Auto-deploy is working. Keepalive (cron-job.org → /api/health) must stay active or host sleeps again.
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
- **Workspace `policy.env` placeholder secrets silently block real `.env.local` resolution.** Resolution order is `policy.env[NAME]` → legacy policy field → `process.env`, with non-empty placeholder values winning. Caught a `sk-test-…` `OPENAI_API_KEY` on the dog-food workspace that was blocking every chat / enricher / classifier call. No validation on save. Worth a one-time audit on every workspace before pointing real traffic at it; longer-term, a "looks-like-test-key" lint on settings save would help.
- **Relationship-edge graph LIVE on af602fa1** (`policy.enrichment.resolve_entities=true`, deployed 2026-05-31). Enricher now writes `object_entity` edges (open vocab — any fact with object_entity set is an edge) and creates domain-grounded `candidate` entities; verified on dev (customer_of→Stripe, integrates_with→Notion, investor→Sequoia). Fills SLOWLY: only ATS source is active (daily 13:00 UTC, ~5 hiring_post signals/day), no entity-discovery sources on, last accounts created 05-19. Watch with `scripts/density_check.ts` (snapshots + delta to `.claude/density_log.jsonl`; baseline = 123 works_at edges, 0 relationship edges).
- **Candidate promotion deferred.** Candidates are thin nodes (name + is_a + domain; `scoreEntity` skips `attributes.candidate=true`). Promotion (embed + enqueue enrichment at ≥N connections) NOT built — set the threshold from real candidate volume once it accrues. Re-embedding is also still write-once-at-create (only `yc.ts`, default perspective); a debounced "re-embed on enrichment" belongs in the same promotion path.
- **Signal-sourcing decision OPEN** (was mid-discussion at wrap). Exa/HN/web content discovery returned garbage (the junk entities "contact", "Not specified"=sociable.co, and content fragments are the residue). Recommendation forming: pipe a structured provider (Clay etc.) through the existing inbound webhook/CSV ingestion per the "data comes in" direction; do NOT revive content-search-as-entity-discovery (query craft isn't self-serve for future users). Hiring posts are stack/role-heavy, relationship-light — relationship edges (customer_of/backed_by) need news/funding signals.
- **~60 `.is('supersedes', null)` reader sites still return the STALE pre-supersede fact.** Only the graph/scoring/query path + the `query_facts_by_similarity` RPC (migration 0035) were fixed 2026-05-31. Direction: newer fact points to older (`new.supersedes = old.id`), so `.is('supersedes', null)` yields the original. Correct pattern = exclude ids pointed at by another fact's `supersedes` (`excludeSuperseded` in `packages/primitives/src/relations.ts`). `loadBestContactScore` fixed 2026-06-01 (one more site).

### Two-tier scoring + contacts (open items, 2026-06-01) — see `HANDOFF_2026-06-01.md`
- **Reach-out thresholds + score weights are UNCALIBRATED.** Jake flagged routing as "random and flimsy" — fair. The draft/research/drop cutoffs (0.65 / 0.5 / 0.35) and the 6-part score blend (industry .30 / stage .20 / signal .10 / evidence .20 / recency .10 / graph .10) are hand-picked defaults, tunable per workspace (`policy.routing`), fit to NO outcome data. They encode intuition, not validated reply/meeting signal. Needs a calibration loop (feed real outcomes back, fit the numbers). Biggest "is it real" gap. Same for `signal_strength`, which gates draft at ≥0.7 but is just an LLM 0-1 judgement.
- **Drafter doesn't enforce the constitution's hard rules.** deepseek-v4-flash put an em dash in the EarthaPro draft despite "no em dashes EVER." Fix = post-processor after the LLM (strip em dashes, run banned-phrase + `forbidden_field_terms` lists) instead of trusting the model.
- **`value_themes` stale for the tiny-team ICP.** Gate themes `hiring/headcount/token_cost/ai_integration` include AI-startup leftovers (token_cost, ai_integration). Corrected-ICP trigger is "hiring first salesperson / scaling outbound." Refresh alongside the ICP.
- **No OBSERVED contact-signal source.** Contact scoring's LLM signal slot works (rated a real funding post ~0 buying-intent, a "drowning in outbound" post 1.0 — correct), but nothing feeds it real events. The EarthaPro demo signal was hand-synthesized from Exa firmographics + the founder's Vibe resume, NOT a detected event — Jake caught this. Need a per-contact signal source (Exa for funding/hiring/posts) or it stays manual. Exa is already keyed in prod, ~free under the 1k/mo tier.
- **`enrich_contacts` autonomous path needs an Explorium REST client + key.** Action fully wired (`contacts.requested` event → `contactsRunner` → 3-day cooldown, all verified) but the `explorium` branch no-ops: the Vibe MCP is chat-session-only, not callable from Inngest. Build a ~60-line Explorium REST client keyed by customer `EXPLORIUM_API_KEY` (self-serve, 100 free credits, ~$0.04/credit). Hunter branch works today (~10% small-co coverage).
- **Account with ZERO contacts routes account-only (decision open).** `loadBestContactScore` returns undefined with no `works_at` contacts → selectAction skips the contact gate. Conservative; whether no-contact should force `enrich_contacts` is unresolved.
- **Dogfood ICP corrected.** Workspace `icp` was stale sim-ai config; reset to PRIMARY = tiny B2B founder-led (1-20, any vertical, no sales hire), SECONDARY = AI-forward B2B SaaS (10-200). Don't blend. Contacts: 173 total / 83 accounts; 5 ICP test accounts (EarthaPro/Latch/TackPilot/Ottomatiq/TrueRev) scored 0.67-0.71.

### Automation revival + drafter quality (2026-06-05) — see progress_log
- **Crons were dead ~4.6 days; root cause = host, not code.** Fixed: merged llm-ai-sdk-registry → main, auto-deploy pushed it live. Diagnose-fast next time: `scripts/_diag_sources.ts`. `pnpm hiring:run` (WORKSPACE_ID=af602fa1…) = instant manual fresh data. Live host: https://agent-crm-fm1f.onrender.com. Keepalive (cron-job.org → /api/health) must stay active.
- **Drafter quality rules are UNCOMMITTED (dev only) — must commit + deploy for the AUTOMATED drafter to use them.** `prompt_builders.ts`: removed the hardcoded opener examples the model was parroting verbatim; added a "callout must be real evidence of a pain we solve, else refuse" rule, a general "DON'T BEND THE SIGNAL TO FIT THE PITCH — signals cut both ways" rule, and a no-fabrication rule. `agent_logic.ts`: sanitizer now strips `${}`/`{{}}`/`<>` template tokens, and `to_email` falls back to `outreach.override_to` when no contact is linked. UI: "icp"→"score" relabel (feed badge, entity cards, sort option, chat score cards) since the displayed `icp_fit` was always the composite `icp_total`. Verified across 5 real accounts: relevant, varied, refuses on no-signal, pulls benchmark numbers where they fit.
- **af602fa1 drafter config populated (resolves the 2026-06-02 empty-`value_props` dormancy).** `about` rewritten (agent-first, graph-based, each claim explained + backed by real v1 benchmark numbers, plain voice, no jargon); `value_props`/`pain_points`/`tone_keywords` set; `outreach.override_to` = agentcrm91@gmail.com. All live in DB. Editable at **Settings → Workspace → About** (saving re-derives the structured fields).
- **All drafts show `to_email: null`** — no contacts linked to these accounts, so they route to `override_to` at send. Real recipients depend on the contact-enrichment path (Explorium/Hunter).
- **Routing gate confirmed, not broken:** automated drafts require composite score ≥ 0.65 (`DRAFT_ICP_TOTAL`, default; `policy.routing` unset). The "emails at 0.57" Jake saw came from manual triggers (chat draft tool + test scripts) that bypass `selectAction`.

## Plan File

Most recent: `enumerated-foraging-spindle.md` — Twenty steals. Phase 1 (auth + members + API keys + Docker self-host) + Phase 3 (settings reorg, external MCP binary, Supabase self-host) SHIPPED. Phase 2 (entities.kind → is_a fact) PARTIAL — dual-state stable; 0032 column drop + `find_similar_entities` RPC rewrite parked with the finish plan.

Older plan-file history lives in `progress_log.md`.

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
