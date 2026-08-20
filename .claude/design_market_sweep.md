# Design: market sweep

Status: designed, not built. 2026-08-20. Read `pillars_and_sweep_2026-08-20.md`
for the measurements this rests on and the holes in them.

## The problem, stated as a cost

Research spends one search asking "what happened to account X?". Measured over 30
days on Sudden: 4,218 searches produced 91 accounts carrying a usable dated
reason. **46 searches per reason, $0.69 each, $63/month.**

The mismatch is that news is published per EVENT and read per COMPANY. An article
titled "FAST channel launches this week" names a dozen companies. The current
design pays for that article once per company it wants to know about, and throws
it away 11 times out of 12 — measured, 2,741 pages a fortnight discarded for
naming a company other than the one we searched for.

## What it is

One search per EVENT CLASS instead of one per account. Every company named in the
results is a candidate hit against the book.

```
today   2,000 accounts x 1 search  ->  events for accounts that had one
sweep   ~10 searches/day           ->  every event in the market, matched to the book
```

## Pipeline, and where it inserts

The insert point is the **signal layer**, so everything downstream is untouched.

```
1. QUERIES     market-level, generated from workspaces.about + the brief
                 "streaming service launches new channel or market"
                 NOT "{entity} launches" — no entity token at all

2. SEARCH      runExaSearch({ category: 'news', start_published_date: yesterday,
                              num_results: 25 })
                 one search per query per day

3. SUBJECT     one deepseek-v4-flash call per query, thinking disabled,
               json_object, batched over all 25 results:
                 "for each item return the ONE company it is primarily about,
                  and what happened, in six words"
               Token matching does NOT work here — proven, see failure 1.

4. RESOLVE     subject name -> entity, in this order:
                 a. exact match on normalised entities.name
                 b. match on attributes.aliases (resolveAliasesViaSearch already
                    populates these; 63 accounts have them today)
                 c. domain match: article's outbound links vs attributes.domain
               No fuzzy matching. A miss is cheaper than a wrong match.

5. EMIT        for a matched entity, create_signal exactly as researchRunner does:
                 type: 'research_result'
                 structured_tags: { signal_source: 'sweep', sweep_query, exa_id,
                                    url, published_at, answers_question }
               From here the existing path runs unchanged: matchSignal ->
               enricher -> facts (with happened_at) -> score -> anchor -> draft.

6. UNMATCHED   a named company that is NOT in the book is free discovery. Park it
               behind a flag; do not build in v1 (see failure 5).
```

**Keep the relevance gate.** Step 3 says "this article is about Zattoo". It does
not say "Zattoo is someone we can serve" or "this answers a brief question".
`filterResultsByEntity` still runs and is what stops the sweep from flooding the
book. Skipping it is the single most tempting and most damaging shortcut here.

## Cost model

Per query per day: 1 Exa search ($0.015) + 1 flash call (~$0.001).

| sweeps/day | monthly cost | measured yield basis |
|---|---|---|
| 5 | $2.40 | the tested config |
| 10 | $4.80 | recommended start |
| 20 | $9.60 | past the point overlap flattens |

**Yield, and be careful here.** The test used a **14-day** window and found 19
unique in-book accounts from 4 working sweeps. A daily sweep only sees one day of
news, so the honest per-day expectation is roughly 19/14 ≈ 1.4 accounts per sweep
set, call it 2-4/day with 10 queries. That is **60-100 accounts/month against the
current 91, at about $5 instead of $63.**

So the claim is **not 177x. It is roughly the same coverage for about a twelfth of
the cost**, and fresher. That is the number to defend.

## Effect on each pillar

**Efficiency** — replaces the exploration bucket, which currently gets 50% of the
budget at 1 search per account and produced 0 usable reasons across 274 accounts
at that spend level. Sweeps cover the same "find me accounts I am not already
watching" job for a fraction of the money.

**Research quality** — the per-account model visits on a 96h+ cadence, so it finds
things up to 30 days old. A daily sweep finds an event the day it publishes.

**Outreach quality** — this is the underrated one. `trigger_fresh_days` currently
lets the drafter open on something up to a month old. Sweeps make "you crossed
110M users last week" the normal case instead of the lucky one, and freshness is
most of what separates a cold email that reads alive from one that reads canned.
No drafter change required.

## Failure modes, with evidence

1. **Name matching by token is catastrophic.** Tried it: "NEXT Thursday" matched
   an account called NEXT TV, "Sport TV" matched "S Sport Plus" on the token
   `sport`, "USA Today" matched "Today I closed a chapter". Unusable. The model
   naming the subject worked cleanly. Do not re-attempt token matching.
2. **Big-company bias is structural.** The 19 included Roku, Netflix, Comcast,
   Amazon, ESPN, FOX, YouTube, Disney+. Sweeps surface what is newsworthy, so
   this cannot be tuned away. It is why the sweep replaces the exploration bucket
   and NOT the high-value bucket: quiet accounts still need per-account probing.
3. **Roughly half the hits are unwritable.** ESPN/FOX/Comcast are live sport,
   vetoed by Sudden's `cannot_write_about`. Netflix/Amazon/YouTube run delivery
   in-house. The relevance gate already catches this, which is why step 5 keeps it,
   but it means gross hits overstate usable hits by about 2x.
4. **Overlap flattens fast.** 52 in-book hits collapsed to 19 unique across four
   sweeps. Query set design matters more than query count; 20 near-identical
   sweeps buy almost nothing over 10 distinct ones.
5. **Unmatched companies are a flood risk.** 25 results x 10 sweeps = up to 250
   named companies a day, most not in the book. Auto-creating them is how the book
   filled with junk entities the last time discovery ran. Flag off in v1.
6. **Duplicate events.** The same launch appears in five outlets. `dedupeResearchCandidates`
   already collapses near-identical results by embedding cosine, but it dedupes
   within a run — sweeps need it across the day's sweeps.
7. **Spent anchors.** An event may already have been the reason for a message.
   `loadUsedAnchorIds` handles this at draft time, so it is covered, but a sweep
   hit on an already-written account will still cost an enrichment call.

## Build order

1. **Measure before building.** Run the sweep daily for 7 days beside the current
   system, writing nothing. Count accounts made draftable **that the per-account
   path did not find**, per dollar. That single number decides everything and
   nobody has it. `scripts/_tmp_market_sweep.ts` is the seed.
2. Sweep-query generation from `about` + brief. Reuse the planner; it already
   writes angles from a description and is working again as of `07727f5`.
3. The runner: search -> subject extraction -> resolve -> `create_signal`. Small,
   because everything downstream already exists.
4. Rebalance `DEFAULT_SELECTION_MIX`: move the exploration share to sweeps, keep
   high_value and active_comms on per-account probing.
5. Only then consider unmatched-company discovery, behind a workspace flag.

## How you know it worked

- accounts made draftable per dollar, sweep vs per-account, same week
- median age of the anchor fact at draft time (should fall from ~weeks to ~days)
- gross sweep hits vs hits surviving `filterResultsByEntity` (expect ~2x loss;
  a much worse ratio means the query set is wrong, not the design)
