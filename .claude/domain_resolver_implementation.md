# Implementation: search-based domain resolution for accounts

**Written 2026-07-16. Scoped to one working day including verification.**
**Read `.claude/session_checkpoint.md` (2026-07-14 through 07-16 blocks) before starting if anything here seems stale.**

## Goal

Set `attributes.domain` on accounts that lack one, using one Exa search per account, verified with the existing name-match guard. Sudden workspace `e7052848`: 34 of 2,063 entities have a domain today. No domain blocks own-site research angles (the highest-trust angle), ATS hiring checks, and Hunter contact pulls. Cost: ~$0.005 per account, ~$10 for the whole book, ~$1 for the top 200.

Do not re-litigate the approach. Decisions below were made deliberately on 07-16 after the related fixes shipped.

## What already exists (reuse, do not rebuild)

| Piece | Where | Notes |
|---|---|---|
| `normalizeDomain()` | `packages/tools/src/ingest.ts:106` | Now rejects hosts without a dot and social hosts (NON_COMPANY_HOSTS). Every candidate host goes through this. |
| `nameMatchesHost(name, host)` | `packages/tools/src/domains.ts` | The precision guard. Proven live: rejected IMAX→amazon.com, Dell EMC→bissada.net. |
| `backfillAccountDomainsFromContactEmails()` | `packages/tools/src/domains.ts` | The pattern to mirror: never overwrite an existing domain, precision over recall, dry-run via `apply: false`, writes go straight to `entities.attributes`. |
| `runExaSearch(apiKey, params)` | `packages/tools/src/exa_search.ts:45`, exported from tools index | Params shape visible in `inngest/functions/research.ts` `buildAngleRequest` (~line 92). |
| `recordActivityMarker` / `latestMarkerAt` / `ACTIVITY_MARKERS` | `packages/tools/src/activity_markers.ts` | Markers live in the `events` table keyed by `action`. Add new marker names HERE, nowhere else. |
| Exa key resolution | `resolveEnvVar(policy, 'EXA_API_KEY')` from `packages/tools/src/policy.ts` | Resolves workspace policy.env first, then process.env. Do not read process.env directly. |
| Research runner | `inngest/functions/research.ts`, `runEntityResearch()` | As of commit `78e3ac8` it slices the per-account angle budget from the RUNNABLE angles (own_site filtered out when no domain). The resolver hooks in right there. |

## Design (decided)

1. **Core resolver** — `resolveDomainViaSearch()` in `packages/tools/src/domains.ts`:
   - One Exa search: query `"<entity name>" official website`, `num_results: 5`, no category, no recency filter.
   - For each result in rank order: `normalizeDomain(url)` → skip null → `nameMatchesHost(name, host)` → first pass wins.
   - Precision tightener (start with it ON): require the winning host to appear in at least 2 of the 5 results, OR be rank 1. Loosen only if the dry-run hit-rate is too low AND every hit is correct.
   - If nothing passes: return null. A wrong domain is worse than none; it poisons the research identity gate, ATS, and Hunter.
   - Never overwrite an existing `attributes.domain`.
   - On success: read-merge-write `entities.attributes` (JSONB: fetch attributes, spread, update), then `recordActivityMarker` with a new `DOMAIN_RESOLVED` marker (payload: `{ domain, evidence_urls }`).
   - On failure: write a `DOMAIN_RESOLVE_FAILED` marker so callers can cool down (see below). Add both names to `ACTIVITY_MARKERS`.

2. **Runner integration** — in `runEntityResearch()` (`inngest/functions/research.ts`), right after the entity/domain fetch (~line 171) and before the runnable-angle slice:
   - If `!domain` and `policy.research.resolve_domains !== false` and no `DOMAIN_RESOLVE_FAILED` marker in the last 30 days (`latestMarkerAt`): call the resolver. It costs one search; increment `searches` and reduce the angle budget by one (`angle_count - 1` for the slice).
   - If it resolves, recompute `runnable` with the new domain so own_site angles run in the same tick when budget remains (hot accounts get this immediately; cold picks with `angle_count=1` spend the tick on resolution and research on the next pick — that is fine and self-healing).
   - Config knob is `policy.research.resolve_domains` (boolean, default true — it spends from the existing research budget, no new spend class). It must be a policy knob, NOT an env var. Vertical-neutral, so a code default of true is acceptable.

3. **Bulk backfill script** — `scripts/_resolve_domains_bulk.ts` for the Sudden demo (the runner integration alone takes weeks at dispatcher pace):
   - Args: workspace id prefix, `--top N` (default 200), `apply` (dry-run without it, mirroring `scripts/_cleanup_bogus_domains.ts`).
   - Selection: accounts lacking a domain, ordered by current `icp_fit` score descending. Current score = the icp_fit fact row NOT pointed to by any other row's `supersedes` (do NOT use `.is('supersedes', null)` — that returns the stale original; this exact bug is documented in the 07-13 checkpoint).
   - Prints every hit with evidence URLs and every rejection with the reason. Writes the same two markers so the runner does not re-spend on the same accounts.
   - After apply: for accounts that just gained a domain AND have `attributes.ats.provider === 'none'`, delete the `ats` key from attributes so the next daily ATS run (13:00 UTC cron) re-probes immediately instead of waiting out the 30-day reprobe window (`reprobe_days`, `inngest/functions/sources/connectors/ats.ts:356`). That hint was recorded when the entity had no domain; it is invalid now.

## Step-by-step

1. Add `DOMAIN_RESOLVED` + `DOMAIN_RESOLVE_FAILED` to `ACTIVITY_MARKERS` (`packages/tools/src/activity_markers.ts`).
2. Write `resolveDomainViaSearch()` in `packages/tools/src/domains.ts`. Export from `packages/tools/src/index.ts`.
3. Typecheck: `pnpm exec tsc --noEmit -p packages/tools 2>&1 | grep domains` — ignore the pre-existing TS5097 import-extension noise, and pre-existing errors in `primitives/llm.ts` + `diff_draft.ts`. They are not yours.
4. Write `scripts/_resolve_domains_bulk.ts`. Dry-run against Sudden: `pnpm exec tsx scripts/_resolve_domains_bulk.ts e7052848 --top 20`.
5. **Stop and eyeball the 20.** Bar: at most 1 wrong candidate in 20, and wrong ones must be rejected by the guard, not written. Good test names in the book: Globoplay (expect a globo.* host), Pluto TV (already domained, must be skipped), Miami Heat (sector-string domain was cleaned 07-16; nba.com/heat would FAIL nameMatchesHost — correct, leave unset).
6. Apply top 200 (~$1). Save the output.
7. Wire the runner integration (step 2 in Design). Typecheck `-p inngest`.
8. Verify live, cheapest first:
   - Local single-account run: import `runEntityResearch` in a temp script (pattern: `scripts/` + dotenv `.env.local`, run from repo root), pick one NEWLY domained account, `angle_count: 3`. Expect an own_site search to run. Note: the direct enricher dispatch inside the runner logs `enricher dispatch failed` locally (no INNGEST_EVENT_KEY) — that is expected and non-fatal as of `78e3ac8`.
   - Commit + push (Render auto-deploys from GitHub main; a local commit alone does nothing).
   - Watch the next 4h research tick (00/04/08/12 UTC): `research_error` events with "no runnable angles" should drop sharply; `research_completed` markers should show `results_created > 0` for cold picks. Markers are in the `events` table, column is `action` (not `type`).
   - Next 13:00 UTC ATS run: newly domained accounts get probed; check `sources.last_run_summary` and any new `kind: 'hiring'` signals.

## Codebase traps for a fresh session (all hit recently, all real)

- Scripts must live in `scripts/` (module resolution fails outside the repo) and start with `import { config } from 'dotenv'; config({ path: '.env.local' });`. Run from repo root with `pnpm exec tsx`. No top-level await with `tsx -e`.
- PostgREST caps every select at 1000 rows silently. Use `fetchAll` from `packages/tools/src/paginate.ts` or explicit `.range()` pages.
- `facts` columns: `subject_entity`, `predicate`, `object_text` (NOT entity_id/name). `events` has `action` (NOT type). `gates` has `decided_at` but no created_at. A bad column in a select can return empty data next to a valid head-count with no error — check `.error` in diagnostics.
- `entities.id` is uuid; `LIKE` does not work on it. Match with `eq` on the full id, or fetch and filter in JS.
- Dogfood (`af602fa1`) is paused scope=all, intentionally, closed topic. Skip it in any bulk run; do not suggest resuming it.
- Destructive prod writes (deleting rows, stripping attributes) need Jake's explicit confirmation; dry-run first, always. Attribute merges that only ADD a missing domain are fine to apply after the eyeball check.
- Never change any configured LLM/embedding model id. Never hardcode customer-specific values (names, phrases, thresholds) in code — config lives on `workspaces.policy`.
- No em dashes and no banned jargon in anything user-facing, including doc/comment prose.
- Temp diagnostic scripts: `_`-prefix, delete when done. Keep only tools with dry-run/apply modes.

## Explicitly out of scope today

- **Batch-aware enrichment** (only the FIRST research article per batch is enriched; the coalescer skips the rest — `inngest/functions/agent_logic.ts` coalesce logic + `research.ts` direct dispatch). Separate change with its own verification; do not bundle.
- Similarity threshold (0.3) for organic source signals.
- Redraft-on-new-facts / follow-up sequences.
- Explorium/Apollo contact connector (backlog).

## Definition of done

1. Dry-run output reviewed, apply run on top 200 saved to the session log.
2. Runner integration deployed (pushed to main, Render live).
3. One post-deploy research tick observed with domained cold picks producing results.
4. `.claude/session_checkpoint.md` updated with counts (domains set, hit rate, rejections) and `progress_log.md` entry written.
