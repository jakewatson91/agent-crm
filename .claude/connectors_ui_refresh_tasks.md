# Connectors UI refresh — task list (resume point)

## Why
Jake: "this is too complicated. Simplify the connections UI. There shouldn't be 5 places to set this stuff up." Contact-provider (Hunter/Explorium) config is currently scattered:
- Settings → Workspace → Budget → "Contact lookups per daily run" = `policy.enrichment.max_contact_pulls_per_run` (`apps/web/app/workspace/[ws]/settings/workspace/page.tsx:85,185,231,506`). Daily cap, bounds the SCHEDULED advance-pass contact pull only.
- Settings → Connectors → Hunter card → "Monthly lookup cap" = `policy.enrichment.hunter_monthly_cap` (field defined in `packages/tools/src/connectors.ts:157`, type/policy_path metadata — NOT hardcoded text in the React modal, so grepping the modal/card components alone misses it). Calendar-month cap, bounds ONLY the real-time drafter's own per-signal Hunter lookup (`agent_logic.ts:1345` `maybeLinkContactsForEntity`) — NOT the scheduled pass.
- Settings → Connectors → primary/fallback/not-used selector per provider (Hunter, Explorium) — sets `policy.enrichment.contact_provider` / `contact_provider_fallback`.
- API key field, also per-connector card on Settings → Connectors.
- (Possibly more — not fully mapped yet, see Task 1.)

## Tasks

- [x] **1. Finish mapping every place contact-provider config lives.** Done. Turned out most of it was *already* consolidated from earlier work: API key, monthly cap (Hunter only), and the primary/fallback/off role selector all already render on one card+modal per connector (`ConnectorCard.tsx` / `ConnectorModal.tsx`, schema-driven off `packages/tools/src/connectors.ts`'s `fields[]` + the generic `isContact` block). The Workspace Budget page even already had a note pointing users to Connectors for those. The one genuine straggler: **"Contact lookups per daily run"** (`policy.enrichment.max_contact_pulls_per_run`) — still living on Settings → Workspace → Budget, ungoverned by any connector card, because it's not per-provider (it bounds whichever contact source is active).

- [x] **2. Design the consolidation.** No real fork to weigh once mapped — only one field was left scattered, and it doesn't belong inside one connector's card since it's shared across both Hunter and Explorium. Put it in a small shared "Daily contact budget" block above the contact-category cards (mirrors the existing "Default models" block above the model cards). Kept it distinct from Hunter's own monthly cap, per the original constraint (they bound different things and merging would silently change behavior).

- [x] **3. Implement.** Shipped (uncommitted, not pushed):
  - `apps/web/app/api/connectors/catalog/route.ts` — GET now returns `contact.daily_cap`.
  - `apps/web/app/api/connectors/contact-budget/route.ts` — new route, POST `{ workspace_id, max_contact_pulls_per_run }` → writes `policy.enrichment.max_contact_pulls_per_run`. Mirrors the existing `/api/connectors/models` pattern exactly.
  - `apps/web/app/workspace/[ws]/settings/_components/ConnectorHub.tsx` — new `ContactBudget` component rendered under the `contact` category section.
  - `apps/web/app/workspace/[ws]/settings/workspace/page.tsx` — removed the `contactPullsPerRun` state + its `HelpRow`; the `enrichment` policy merge now just spreads `...base.enrichment` so the value set via Connectors survives a Workspace-page save untouched. Updated the pointer note to mention the daily cap too.

- [ ] **4. Verify.** Typecheck clean on the touched files (pre-existing unrelated `.ts`-extension errors in `packages/tools`/`packages/primitives` remain — documented in `project_state.md`, not caused by this change). **Could not click-test — Claude-in-Chrome extension still not connected.** Try reconnecting, then click through: open a workspace's Settings → Connectors, confirm the new "Daily contact budget" block appears under the Contact sources section with the current value prefilled, change it, save, reload, confirm it persisted and the Workspace → Budget page no longer shows the old field.

## Known state as of this checkpoint (2026-07-03, low-token wrap-point)
- af602fa1 is PAUSED (`policy.pipeline.state='paused'`, `policy.research.searches_per_run=0`) — restore via `scripts/_quiet_dogfood_for_sudden_burst.ts continue` once Sudden work is stable. Not done yet.
- Sudden workspace: Jake is setting it up himself via the real UI per his request — unknown workspace id / current state as of this file being written, check fresh rather than assume.
- Hunter has ~39 credits total remaining, shared across both workspaces.
- DeepSeek confirmed working (topped up mid-previous-session).
- Full session recap already written to `.claude/progress_log.md` (2026-07-03 entry) and `.claude/project_state.md` ("Next session — read first" section) — read those for full context before resuming.
