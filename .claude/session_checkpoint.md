# Session checkpoint — 2026-07-12/13 — "Sudden on standard schedule, no laptop"

**Goal:** Sudden workspace (e7052848) fully loaded + enrichment running on the standard cloud schedule with zero laptop involvement, demoable to the client this week. Identify gaps and fix them.

**Resume command if this session dies:** read this file, then continue the task list below from the first unchecked item.

## Diagnosis (verified, don't re-derive)

1. **Cloud schedule IS running for Sudden without the laptop.** advance-accounts-daily ran 14:30 UTC 07-12 (scanned 400, 0 drafts, 3 contact pulls found nobody). Research dispatcher fires every 4h and dispatches ~10 accounts/tick for Sudden.
2. **Exa is OUT OF CREDITS** — every research search 402s ("exceeded your credits limit", dashboard.exa.ai). Research has produced 0 results for 7+ days. THIS is why no new facts/drafts. Jake-only fix: top up Exa.
3. **Domain gap:** 2049/2059 Sudden entities lack attributes.domain → blocks 3/5 research angles ("no runnable angles"), Hunter pulls, ATS. But the 98 CSV contacts have real work emails + works_at links → domains derivable for those accounts (task 1).
4. **Rescore cron was double-broken** (fixed this session, see below): stale scan read the ORIGINAL fact in supersede chains (`.is('supersedes',null)`) so 480 dogfood accounts looked stale forever and hogged all 50 slots/tick; staleness compared against workspaces.updated_at which bumps on EVERY policy write (daily pipeline-status write from advance cron) — would have churned Sudden's full 1813-account book daily via LLM.
5. Sweep RED on Sudden score_distribution (77% decile 6) = CSV-import profile, watch don't fix (per 07-10). Fresh research facts will spread it.
6. events table column is `action` NOT `type` (diag scripts must use `action`).
7. Sudden pending approvals: 3 (2 drafts CBC + SOOP from 07-10). scorable_types + drafter/enricher subs all present on Sudden.

## Task list

- [x] **Task 3 — rescore churn fix (DONE, needs commit+push):**
  - `packages/tools/src/policy.ts`: added `scoring_config_state` to WorkspacePolicy + `ensureScoringConfigState()` (sha256 of icp/about/persona/policy.scoring/contact_scoring/personas/scorable_types; changed_at moves only on real change; epoch-init so deploy doesn't churn).
  - `packages/tools/src/scoring.ts`: both skip-when-stale guards (scoreEntity ~L237, scoreContact ~L548) now compare against scoring_config_state.changed_at, not updated_at; dropped updated_at from selects.
  - `packages/tools/src/activity_markers.ts`: added RESCORE_NOOP marker.
  - `inngest/functions/system_tasks.ts`: rescoreOnIcpChange scan reads CURRENT icp_fit (not-pointed-to), compares vs changed_at, skips entities with rescore_noop marker newer than changed_at; batch writes rescore_noop on null; returns {candidates, rescored, noop}.
  - `packages/tools/src/index.ts`: exports ensureScoringConfigState + fetchAll.
  - Verified live: all 4 workspaces cfg initialized at epoch, staleA=0 everywhere (was 480/1813 phantom), Case B eligible: dogfood 1850 (mostly _candidate → will null+marker quickly, no LLM), Sudden 148 (thin, prefilter writes low score once), test 0, ONBOARDING-TEST 7.
  - Typecheck: my files clean; pre-existing TS5097 noise (89) + primitives/llm.ts + diff_draft.ts errors are NOT mine.
- [x] **Task 1 — domain backfill from contact emails (DONE, needs commit):**
  - New `packages/tools/src/domains.ts`: `backfillAccountDomainsFromContactEmails()` + `domainFromEmail()` + `nameMatchesHost()` guard (account name must match host label — kills agency/consultant contamination like IMAX→amazon.com, Dell EMC→bissada.net). Exported from tools index.
  - APPLIED to Sudden: 34 domains set (CBC→cbc.ca, Pluto TV→pluto.tv, Stingray, Varnish, France TV…), 13 name-mismatch skips (all correct rejections), coverage now 44/2059 — and the 34 are exactly the accounts WITH contacts (the draftable set).
  - Wired into `apps/web/app/api/ingest/import/route.ts` — future CSV imports derive domains automatically (best-effort, returns domains_derived).
  - Runner: scripts/_backfill_sudden_domains.ts (keep).
- [x] **Task 2 — research credit-wall fail-loud (DONE, needs commit):**
  - `policy.ts`: PipelineStatus scope now includes 'research'.
  - `inngest/functions/research.ts`: runner early-exits when paused (research/all); when ALL searches fail AND any error is credit/auth-shaped (reuses isHaltingError from advance_accounts), writes pipeline paused scope='research' provider='exa' with plain reason ("Add credits at dashboard.exa.ai, then click Continue"). Drafting/scoring/contacts unaffected.
  - `entity_research_dispatcher.ts`: skips workspaces paused with scope research/all.
  - `advance_accounts.ts`: research-scoped pause is non-blocking for the advance pass; standing non-'all' pauses survive the end-of-run 'ok' write.
  - `sweep.ts`: new checks — `pipeline_paused` (RED if provider-tripped, YELLOW if manual — dogfood's intentional pause reads yellow now) + `research_yield` (RED when ≥5 runs/48h, 0 results, ≥half errored; surfaces first error text). VERIFIED live: Sudden shows research_yield RED with the Exa 402; dogfood shows yellow manual pause.
  - /api/pipeline/continue already clears any scope — no change needed.
- [x] **Task 4 — scorable_types at creation (DONE, needs commit):** `apps/web/app/api/workspaces/create/route.ts` policy now includes scorable_types: ['account','contact'].
- [x] **Commit + push DONE:** commit `2c91047` pushed to origin/main (also carried previously-unpushed 945e8a3 + 9264026) → Render auto-deploys. `pnpm --filter web build` validated locally, exit 0. Memory files updated (project_scoring_config_state_rescore.md new; project_automation_dies_on_render.md updated; MEMORY.md index refreshed).
- [ ] **Task 5 — Jake-only list (the only remaining items):** (a) top up Exa at dashboard.exa.ai — THE unlock for new drafts this week (default budget 30 searches/4h-tick ≈ 180/day ≈ ~$0.90/day; tune via Sudden policy.research.searches_per_run); after top-up, click Continue on the Sudden banner if the research pause has tripped by then; (b) verified Resend domain + outreach.from_email for real approve→send delivery (currently onboarding@resend.dev, override_to null); (c) nothing else — push is done, schedule is cloud-only, no laptop needed.

## Expected behavior after Render deploy (watch, don't fix)
- First research tick post-deploy: one more burst of Exa 402s → Sudden pipeline pauses scope='research' with the plain banner + Continue. Dispatcher then skips it (no more error spam).
- After Jake tops up Exa + clicks Continue: research resumes; the 34 newly-domained accounts unlock own-site angles; new facts → enricher chain rescores → scores spread past the 0.65 draft gate → advance pass (14:30 UTC) starts producing drafts.
- Rescore cron output shape is now {candidates, rescored, noop}; dogfood will chew through ~1850 never-scored candidate-flagged entities as no-LLM noops over ~2 days, then go quiet. Not a problem.
- Sweep at session start: Sudden shows research_yield RED (or pipeline_paused RED) until Exa is topped up — that's the system working.

## Env notes
- Local dev has all keys in .env.local; Inngest API reachable with INNGEST_SIGNING_KEY (query `https://api.inngest.com/v1/events?name=inngest/function.finished&received_after=...` for cron run results).
- Render host healthy (200 on /api/health). Cloud DeepSeek + OpenAI embeddings both proven working (dogfood enricher scored on 07-11).
- Dogfood af602fa1 stays PAUSED — intentional, closed topic, do not suggest resuming.
- Temp scripts this session: scripts/_chk_sudden_schedule.ts, _chk_dispatcher_global.ts, _chk_rescore_churn.ts, _chk_assert_actors.ts, _chk_cloud_scoring.ts, _chk_run_metrics.ts, _repro_rescore_one.ts, _repro_rescore_dogfood.ts, _repro_rescore_scan.ts, _verify_rescore_fix.ts, _chk_contact_emails.ts (all deletable).
