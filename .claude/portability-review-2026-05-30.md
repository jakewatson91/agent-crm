# Portability review — session 2026-05-30

## RESOLUTION (2026-05-31)

All five action items (1–5) implemented. #6 left as-is (optional; already documented as the canonical outbound motion in `policy.ts` / `lifecycle.ts`).

- **#1** — sweep now reads a generic `attributes._watched_by_source` flag (`system_tasks.ts`); ATS connector sets it true when it adopts a board, false when none (`ats.ts`). No connector named in shared code.
- **#2** — `renderAttributesProse` drops any `_`-prefixed key generically; no key list. Connectors write scalar plumbing under `_discovered_via` / `_search_query` / `_source_url` (web, exa, api_call, custom_http, chat-intake). `ats`/`ats_seen_jobs`/`embedding` were already dropped as objects.
- **#3** — drafter field-name examples moved to `policy.drafter.forbidden_field_terms` (default empty); prompt keeps the generic rule.
- **#4** — enricher DEPTH instruction rewritten vertical-neutral (no job/seniority/comp vocabulary).
- **#5** — fact grouping driven by `policy.display.fact_groups` (default → all "other"); single shared `factFamilyOf` helper (`fact_groups.ts`); both route copies deleted.
- **Migration `0036`** — renames existing scalar plumbing keys to `_`-prefixed and backfills `_watched_by_source` on adopted boards. Applied to the demo workspace (338 rows renamed, 61 watch-flags set). Demo `policy.drafter.forbidden_field_terms` + `policy.display.fact_groups` set to preserve current behavior.

---


Audit of this session's changes against the rule: **shared/base code stays generic; everything agent-crm-specific is config (`workspaces.policy`) or connection (`sources.config`), defaulting to empty/neutral.** This tool is going open-source for any use case.

Verdict: engine-level changes are clean (no customer emails / brands / thresholds in code). But several changes baked agent-crm's sales/hiring **vocabulary**, or a **specific connector's shape**, into shared code. None are customer-data values, but a non-sales customer would have to edit code to change them. Ordered by how much they break "any use case."

---

## HIGH — shared code now knows about a specific connector

### 1. Archive sweep reads `attributes.ats`
- **Where:** `inngest/functions/system_tasks.ts:375-376`
- **Baked in:** the generic entity-archive-sweep checks `e.attributes?.ats?.provider` to avoid archiving job-board owners.
- **Problem:** the shared sweep is coupled to the ATS connector. A customer with different/other connectors gets no protection, and the engine names one connector.
- **Fix:** connectors mark their watch-targets through a generic flag the sweep reads (e.g. a reserved `attributes._watched_by_source: true`, or a `_watch` array), set by any connector when it adopts an entity. Sweep protects entities carrying that flag. No connector name in shared code.

### 2. `renderAttributesProse` hardcodes connector key names
- **Where:** `packages/tools/src/prompt_builders.ts:16` (`PLUMBING_ATTRIBUTE_KEYS`)
- **Baked in:** `ats`, `ats_seen_jobs`, `discovered_via`, `search_query`, `source_id`.
- **Problem:** shared prose renderer knows specific connectors' internal keys; a new connector's plumbing leaks into emails until someone edits this set.
- **Fix:** namespace all connector/internal attributes under a reserved prefix (`_ats`, `_discovered_via`, …) and have `renderAttributesProse` drop any key starting with `_` generically; or read the hidden-key list from config. No connector names in code.

---

## MEDIUM — sales/hiring vocabulary baked into shared prompts + display

### 3. Drafter jargon guardrail lists specific field names
- **Where:** `packages/tools/src/prompt_builders.ts:112`
- **Baked in:** `"domain", "stack", "tech_stack", "funding_stage", "ICP", "score"`.
- **Problem:** these are agent-crm's own field names — wrong examples for any other vertical.
- **Fix:** keep the generic rule + the vertical-neutral data-source phrases ("our system shows", "your profile", etc.); move the field-name examples to config (`policy.drafter.forbidden_field_terms`, default empty) or drop them and rely on the generic instruction.

### 4. Enricher DEPTH instruction re-bakes hiring vocabulary
- **Where:** `inngest/functions/agent_logic.ts:1008`
- **Baked in:** "a job description", "named tool/technology/language", "concrete responsibility", "seniority and reporting/team context", "compensation", "work arrangement".
- **Problem:** this re-introduces in prose the exact hiring shapes we just moved to config (B1). A support/research/other CRM gets sales-flavored extraction guidance.
- **Fix:** make the depth instruction vertical-neutral — e.g. "extract every specific named entity, quantity, date, role, relationship, and attribute the payload states, one atomic fact each, following the workspace example shapes." All vertical shape hints already live in `policy.enrichment.example_facts`.

### 5. Fact-display grouping hardcodes fact names (and is duplicated)
- **Where:** `apps/web/app/api/entities/[entity_id]/facts/route.ts:11` and `apps/web/app/api/channels/[channel]/summary/route.ts:42` — identical `FACT_FAMILIES` "firmographics" arrays: `industry, stage, funding_stage, yc_status, yc_batch, is_hiring, team_size, location, domain`.
- **Problem:** the fact NAME is set in config (`example_facts`), but surfacing it under "firmographics" requires editing two code files — the exact "code change per customer" anti-pattern. (This is where `funding_stage` had to be added by hand this session.)
- **Fix:** drive grouping from config (`policy.display.fact_groups`, or derive groups from `example_facts`), default everything to one "other" group; dedupe the two copies into one shared helper.

---

## LOW — outbound-motion assumption in the lifecycle (mechanism is fine; vocabulary is baked)

### 6. Lifecycle transition keys + order hardcoded
- **Where:** `packages/tools/src/policy.ts:186` (`OutreachTransition` union), `packages/tools/src/lifecycle.ts:25` (`ORDER`), default fact `outreach_stage`, function name `setOutreachStage`.
- **Baked in:** the stage set `researched → drafted → contacted → replied`, the ordering, and the "outreach" naming.
- **Note:** the mechanism (one stage fact, supersede-upsert, only-advance guard) is correctly generic; the fact NAME and per-stage LABELS are already config. Only the KEY SET + ORDER + "outreach" naming are code.
- **Problem:** a non-sales use case has different stages; today that needs a code change.
- **Fix (optional, lower priority — the base agent pipeline IS the outbound motion):** make transitions config-defined — `policy.lifecycle.transitions: [{key, label, rank}]` — base call sites emit their keys, unknown keys no-op. At minimum, document that the lifecycle assumes an outbound motion and is the intended canonical pipeline.

---

## Already clean — no action
- **migration `0034`** (decide_gate actor cast) — engine correctness fix, identical for all customers. ✓
- **RichTextEditor / CitedText / html_email / send_email `html`** — fully generic, no customer values; whitelist is structural shape only. ✓
- This session's **config/data** changes (example_facts shapes, `policy.lifecycle`, `outreach.override_to`, `stage→funding_stage` backfill, un-archive, paused subs/sources) — all live in `workspaces.policy` or are one-time data, not code. ✓
- `setOutreachStage` reads fact name + labels from config (vocabulary caveat in #6). ✓
- `run_hiring_daily.ts` — generic; finds active `ats` sources, optional `WORKSPACE_ID`. (Explicitly the hiring runner — fine.)

## Also worth auditing (pre-existing, not introduced this session)
- The enricher PAIN EXTRACTION examples + other prompt scaffolding in `agent_logic.ts` carry sales-flavored examples — same config-vs-code question applies.
- Scratch `scripts/_*.ts` from this session hardcode the workspace id/entity ids — fine to delete (throwaway dev scripts, not product code).
