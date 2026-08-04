# Research queries: what changed 2026-08-04, and what to pull next

Handoff doc. Scope is the research/query side only. The drafter work from the same day
(angle picker, pitch menu, stable attributes) is in `drafter_quality_plan.md` and is not
repeated here.

Commits, oldest first: `2dde5c8`, `5ee8641`, `ddfdc0b`, `6806d86`, `59dfa13`. All pushed to
`origin/main`.

## Where it stands in one paragraph

The plan said research was finding company descriptions instead of dated events. That was wrong.
Research finds fresh, event-shaped material when it runs; it barely ran, because 57% of the book
had no domain and a domainless account is never a research candidate. Separately, two of five
search angles were asking Exa for a wider date window than the ingestion floor would accept, so
40% of the per-account search budget bought results that were binned on arrival. Both are fixed.
The binding constraint has now moved to the same-name / relevance filter, which is rejecting
11 to 13 results per account. That is the next thread and it is untouched.

## What the measurements actually said

Run before any change, on the Sudden workspace (`e7052848-2270-41ac-90b6-d9b75c87f6d3`):

| question | answer |
|---|---|
| Do research signals carry dates? | 66% of `research_result` signals do. The corpus looks undated only because 2536 of 4226 signals are the CSV import, which is 0% dated by nature. |
| Did the 07-29 freshness fix work? | Yes. Signals ingested after it: 53% from pages ≤30 days old, against 9% across the whole corpus. |
| Is extraction turning events into profile facts? | No. The freshest signals yield `news_event`, `recent_event`, `pain_observed`, `streaming_scale`, `subscriber_count`. |
| Then why do top accounts gate? | Coverage. 1127 of 1961 accounts had no `attributes.domain`. 49 distinct accounts were researched in 6.8 days, i.e. one visit per ~116 days against a 14-day bar for a trigger-led draft. |

The two highest-scored accounts in the book, ShowMax (1.00) and Cineverse (0.95), had
`researched=never`. That is the direct cause of the "ShowMax has no recent dated event" gate.

## Change 1: the domain backfill was correct and just had not run

`scanDomainBackfillCandidates` has ordered candidates by `icp_fit` since `9e33a4a` (07-28). No
bug. What happened was a sequencing accident: the backfill ran 07-29 to 08-01 against the OLD
scores, the full-book rescore on 08-04 is what lifted ShowMax and Cineverse to the top, and the
`0 11 * * *` cron has not fired since 08-01. **A job whose ordering depends on scores is stale
until it next runs.**

Ran it manually. ShowMax sorted first and Cineverse third, exactly as designed.
43 of 75 resolved, 32 no_match, 0 errors, about $0.53 of Exa.
ShowMax → `showmax.com`, Cineverse → `cineverse.com`. 1084 accounts still domainless.

**Rule now recorded in `project_state.md`: after any full-book rescore, run the domain backfill.**

## Change 2: `research.max_age_days` 30 → 90 on Sudden

The ingestion floor was 30 days while the drafter's `trigger_max_age_days` is 90. The drafter
will build a theme-led message on a 60-day-old fact and only needs 14 days
(`trigger_fresh_days`) for something it presents as news. So research was binning, at ingestion,
exactly the material the drafter would have used. Across an 8-account run: 29 results fetched,
paid for, and dropped as stale.

This is workspace config, not a code default. The code default is still 30
(`research.ts:36`). Revert by deleting the key.

Costs no extra searches (these are pages already fetched). It does mean more surviving signals
to enrich, which is where the model spend is.

## Change 3: the query window now respects the ingestion floor (`59dfa13`)

This is the one that answers "why are we researching things that old".

`buildAngleRequest` (`inngest/functions/research.ts`) built the Exa `start_published_date` from
`angle.recency_days` alone, with no reference to `policy.research.max_age_days`. An angle could
therefore ask for a window the gate would never accept:

| angle | asked Exa for | floor | outcome |
|---|---|---|---|
| `open_peak_viewers` | 365 days | 90 | everything 91-365d old fetched, paid for, binned |
| `own_customers` | no limit | 90 | any dated page over 90d binned |
| other three | 30 days | 90 | can never go stale |

Two of five angles, so 40% of the per-account budget could not survive ingestion no matter what
it found.

**Fix:** the window is clamped to the floor whenever the angle sets one. An angle that sets NO
window is deliberately left alone, because that is the evergreen case (customer / case-study
lists) where undated pages are the point and undated pages are exempt from the floor. Clamping
there would exclude the only results that angle exists to find.

**Same drift in the planner prompt:** `research_strategy.ts` stated a hardcoded 30-day floor in
prose, so on a workspace that had moved its floor the model authored angles against a number
that was no longer true. It now interpolates `ctx.max_age_days` and is told never to exceed it.

## Sudden's angles now (regenerated after the fix)

```
exec_cdn_talks    social    30d   {entity} delivery cost OR CDN OR bandwidth OR streaming infrastructure
own_launches      own_site  30d   {entity} launch OR announce OR new feature OR release
customers         own_site  none  {entity} customer OR case study OR partner OR trusted by
peak_concurrency  news      30d   {entity} concurrent viewers OR peak viewers OR simultaneous streams
deals_expansions  open_web  30d   {entity} partnership OR deal OR expansion OR new region OR launch market
```

The planner moved peak-concurrency from a 365-day open-web trawl to a 30-day news angle on its
own, once it was told the real floor. `research.always_include` carries the peak-concurrency
requirement (added because the product needs simultaneous viewers and the floor below which the
swarm does not form is unknown; it is a number to collect, not a veto condition).

## The open thread: the relevance filter is now what rejects everything

Same 4 accounts, after the clamp and the angle regeneration:

| account | stale drops before → after | filtered_out after | signals |
|---|---|---|---|
| Ab Films TV | 5 → 0 | 12 | 0 |
| GoodShort | 2 → 0 | 13 | 0 |
| Weyyak | 2 → 1 | 11 | 0 |
| ShowMax | 10 → 8 | 5 | 0 |

Age waste is essentially gone. `filtered_out` (the same-name disambiguation plus the relevance
check) is now rejecting the large majority of what comes back, and signals created went to zero
in that run.

ShowMax's remaining 8 stale drops come from the evergreen `customers` angle returning old dated
own-site pages, which is the one case the clamp intentionally does not touch.

**Start here next session.** The filter lives in `filterResultsByEntity` and the relevance-check
prompt tightened on 07-29 (which was an LLM prompt change never verified in production). Worth
knowing whether it is rejecting genuinely wrong-company results or being too strict on the new
OR-heavy queries.

## What is NOT proven

I changed two things at once in the last test: the clamp AND the regenerated angle queries. So
the drop in `signals_created` to zero cannot be attributed. The new queries are OR-heavy keyword
lists and may simply be pulling more off-topic results, which would be a query-quality problem
rather than a filter problem. **Do a clean before/after on one variable before concluding
anything about the new angles.**

## ShowMax is closed, do not re-open it

It dropped 10 results as stale both before AND after the floor moved 30 → 90, which means all
ten are over 90 days old. Plus 5 to 7 filtered as off-topic. It has no recent web material
matching these angles, and the drafter gating it is correct behaviour. Giving it a domain was
still the right fix, since it was invisible to research entirely, but it was never the blocker.

## Commands

```
pnpm tsx scripts/_run_domain_backfill_now.ts            # dry list, ordered by score
pnpm tsx scripts/_run_domain_backfill_now.ts --apply    # spends 1 guarded search per candidate
pnpm tsx scripts/_run_research_now.ts 8                 # dry list of top researchable accounts
pnpm tsx scripts/_run_research_now.ts 8 --apply         # ~5 searches per account
pnpm research:check                                     # enrichment loop health
```

**Local runs cannot dispatch.** `_trigger_research_sudden.ts` reports `dispatched: 0,
dispatch_errors: N` and the runner reports `enricher dispatch failed: 401 Event key not found`.
Both are a missing local Inngest event key, not a bug. Signals created from a laptop are not
enriched locally; production's 15-minute `recoverUnmatchedSignals` cron picks them up.

## Cost reference

From the repo's own `DEFAULT_PRICING` (`packages/tools/src/report.ts`). Exa is the expensive
input here, not the models.

- Exa search: $0.007 each, plus ~3 content pages at $0.001. Call it $0.01 per search.
- A research run is ~5 searches per account, so ~$0.05 per account.
- `deepseek-v4-flash` (both the enricher-style passes and the scoring rubric): $0.14 per 1M in,
  $0.28 per 1M out. A full-book LLM pass over ~1900 accounts is about $0.75, and the rescore it
  triggers about $1.70.
