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

## RESOLVED 2026-08-04 (second session): the filter was right, the searches were wrong

The open thread below asked whether the filter was rejecting genuinely wrong-company
results or being too strict. Answer: **genuinely wrong-company, and it is not the filter's
fault.** Dumping every candidate with its verdict (`_chk_gate_verdicts.ts`) showed what the
gate was binning for Weyyak: UFC fight ratings, Kai Cenat's Twitch numbers, Naver Chzzk.
For Ab Films TV: ABS-CBN, Canal+/MultiChoice, three unrelated production companies. The
gate was correct every time.

**Why those results came back at all.** Every off-domain angle already sends Exa
`includeText: [entity name]`. Exa only honours that on keyword routes. Measured on one
query (`_chk_exa_includetext.ts`):

| search type | results naming the target |
|---|---|
| `neural` | 0 of 3 — identical to sending no filter |
| `auto` (what the runner sends) | 2 of 3 |
| `keyword` | 0 results, which is the truthful answer |

So for a small brand plus topic words, the embedding is dominated by the topic and Exa
returns the best pages about *concurrent viewers*, not about *Weyyak*. We paid Exa for
them, then paid the relevance gate to reject them. That is why identity was 55% of all
1780 drops across 219 runs, against 18% substance and 11% relevance.

**Fix: the name gate (`pageMentionsEntity`).** Re-imposes `includeText` locally, for free,
before the LLM gate runs. Off-domain results only; own-domain is exempt because the host
already proves identity. Live results:

| account | killed free, never hit the LLM | reached the LLM |
|---|---|---|
| Ab Films TV | 12 | 0 |
| Weyyak | 6 | 5 |
| Cineverse | 0 | 10 |
| Astro (sooka) | 0 | 6 |

Cineverse at 0 is the point: an account with real coverage is untouched.

**It abstains far more than it judges, on purpose.** Letting junk through costs one LLM
call (the status quo); dropping a real page costs a signal. Four abstain rules, each one
put there by a false kill caught in testing, not by theory:

- **no domain → abstain.** "Warner Brothers Discovery" is reported as "Warner Bros.
  Discovery"; no shared run-together substring. Killed 4 real articles in a live run
  before this rule. That account now produces a signal again.
- **acronym domain (cbc.ca, wbd.com) → abstain.** "cbc" is a substring of too much, and
  the full name is no help since coverage writes "CBC".
- **short brand (OSN+, M6) → abstain.** Coverage says "OSN", never "osnplus".
- **slash or bracket = two brands.** "Videotron/Quebecor" and "Astro (sooka)" are each
  written as only one half. Before this, videotron.com's *own* pages were flagged as the
  wrong company and every sooka article was dropped.

For the case no string surgery reaches, `entity.attributes.aliases` feeds extra names in.
Crazy Maple Studio is covered exclusively as "ReelShort", so all 4 of its real articles are
still dropped until someone sets `aliases: ["ReelShort"]` on that record. **Not yet set —
it is production data.** Worth a sweep for other accounts known by a product name.

`scripts/check_name_gate.ts` locks all of this in and runs inside `pnpm check`.

## The signal corpus already holds wrong-company material

`_chk_signal_corpus_quality.ts` runs the same check over stored signals: **54 of 1662
research signals (3.2%) never name the company they are attached to.** All 54 are from
July; August is 0 of 80, so the 07-29 gate tightening plus this fix closed it going
forward. The July ones are still there and the enricher has already turned them into facts
the scorer and drafter read — Ab Films TV alone carries `ablfilms.com`, `abfilms.ca`,
`shots.com` and `linkedin.com/company/bliss-point-media`. Nothing has been deleted.
Cleaning them up is a separate decision.

Read that number as a floor, not a total. The check abstains on acronym domains, on
domainless accounts and on short brands, so wrong-company signals on those accounts are
invisible to it.

## Still open: one angle in five buys nothing, on every account

The `social` angle (`exec_cdn_talks`) returns bare LinkedIn *profile* pages —
`linkedin.com/in/...` for Volker Brack, Rohit Arora, Nadine Samra, Yoko Chen — on every
account checked. A profile page carries no dated event, so it can never become a signal.
The name gate does not catch them, because the person genuinely works there and the
company name is on the page; they reach the LLM and get rejected. That is roughly 20% of
the per-account search budget plus an LLM judgement, spent to learn nothing, every run.

Same shape on `own_site`: GoodShort's `customers` angle returned its own privacy policy,
user agreement and homepage; `own_launches` returned three drama-title catalog pages.

Worth knowing before changing the queries: on an account **with** coverage, query shape
barely matters. All five shapes tested against Cineverse returned 5/5 on-topic
(`_chk_query_shapes.ts`). The OR-heavy templates are not what is hurting the covered
accounts. What they do cost is variety — four of the five shapes collapsed onto the same
earnings-report cluster, which dedup then folds to about one signal, while a bare-name
query returned five distinct stories.

## Also unresolved: 15% of drops record no reason

`droppedBy.unreported` was 252 of 1780. The pattern in the event log is distinctive: when
`unreported` is non-zero, every other bucket is zero and signals still got created (Sport
TV 10 created / 10 unreported, ViX 4/10, M6+ 6/10). That is the model returning its
`matches` array and omitting `rejects` entirely, not a truncation — a truncated response
would fail to parse and create nothing. Telemetry gap only; no signal is lost.

## The original open thread (superseded by the section above)

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

**Answered above.** It was rejecting genuinely wrong-company results, and the reason they
arrived at all was Exa ignoring `includeText` on neural routes.

## What is NOT proven

The earlier worry that the new OR-heavy queries were pulling off-topic results turned out to
be the wrong suspect: on Cineverse every query shape returned 5/5 on-topic. The off-topic
results were coming from Exa filling slots on accounts with no real coverage.

Still unproven: whether the OR-heavy templates cost signal *variety* on covered accounts.
Four shapes collapsed onto one earnings cluster while a bare-name query returned five
distinct stories, but that is one account and one angle. Test it properly before rewriting
any template.

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

# added this session (all read-only unless noted)
pnpm tsx scripts/_chk_filter_breakdown.ts 10            # which gate test is doing the rejecting, from the event log
pnpm tsx scripts/_chk_gate_verdicts.ts "Weyyak"         # per-result verdicts. SPENDS ~5 searches/account
pnpm tsx scripts/_chk_signal_corpus_quality.ts --list   # stored signals that never name their company
pnpm tsx scripts/_chk_exa_includetext.ts "Weyyak"       # proves neural ignores includeText. ~4 searches
pnpm tsx scripts/_chk_query_shapes.ts "Cineverse"       # compare query shapes. ~6 searches
pnpm tsx scripts/_chk_gate_context.ts --zero            # what grounding the gate actually gets
pnpm tsx scripts/_run_research_named.ts "Weyyak"        # real runner on named accounts. SPENDS + creates signals
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
