# Three pillars, and the market-sweep finding

Written 2026-08-20. Everything here was measured on Sudden (`e7052848`) this
session unless marked otherwise. Pick up from "What to do next".

## The pillars (Jake, 2026-08-20)

**Efficiency. Quality in research. Quality in outreach. That is it.** Every idea
gets judged against those three and nothing else.

---

## The finding: sweep the market, don't interrogate the account

Today one Exa search asks "what happened to account X?". Measured over 30 days on
Sudden: **4,218 searches produced 91 accounts carrying a usable dated reason. 46
searches per reason.**

A market-level search asks "what happened in this market this week?" and every
company named in the results is a candidate. Measured, 2026-08-20:

```
5 market searches, $0.07, 14-day window, category=news
  -> 4 of 5 returned results (one came back empty)
  -> 100 results -> 100 companies named -> 52 in-book hits -> 19 UNIQUE accounts
```

Examples: Roku launched its first AI FAST channel (08-20). Tubi topped 110M users
(08-06). Samsung TV Plus expanded an All3Media deal (08-17). FreeCast launched a
28-channel Brazilian package (08-20). Zattoo expanded FAST channels (08-14).

Why nobody does this: every data vendor prices per record (Clay per row, Apollo
per contact). If you pay per company you never think to buy the news once and
match it to a list you already own.

### Serves all three pillars at once

- **Efficiency** — far fewer searches per account found.
- **Research quality** — everything found was inside 14 days, most inside 10. The
  per-account model visits on a cadence, so it surfaces things up to 30 days old.
- **Outreach quality** — "you crossed 110M users last week" is a different message
  from the same sentence about something three weeks stale. This improves the
  writing without touching the drafter.

### HOLES IN THAT CLAIM — read before quoting the numbers

1. **The 177x headline is wrong and must not be repeated.** 46-searches-per-reason
   counts a *fully qualified* result: gate passed, enriched, a dated fact written.
   0.26-searches-per-hit counts *a company named in a headline*. No relevance gate,
   no enrichment, no fact, no check against what the workspace sells. These are
   different units.
2. **Roughly half the 19 would fail the gate Sudden already has.** ESPN, FOX and
   Comcast hits are live sport, which `cannot_write_about` vetoes outright. Netflix,
   Amazon, YouTube and Disney+ are the wrong size or run delivery in-house. A fair
   estimate of writable hits is ~10 of 19, so call it ~0.5 searches per usable
   account and treat even that as unproven.
3. **Overlap is steep.** 52 in-book hits collapsed to 19 unique across four sweeps.
   Fifty sweeps will not return 190 accounts; the curve flattens fast.
4. **Marginal coverage is unmeasured.** Several of the 19 (Netflix, Crunchyroll)
   are almost certainly already inside the existing 91. Nobody has measured how
   many accounts the sweep finds that the per-account path would have MISSED, and
   that is the number that actually justifies the change.
5. **"Find it the day it publishes" is a hypothesis.** The test used a 14-day
   window. Daily sweeps were not run.
6. **No dedup against spent anchors.** Some of these events may already have been
   the reason for a message.
7. **Big-company bias is structural.** Sweeps surface what is newsworthy. Quiet
   companies never appear, which is exactly the population the per-account probe
   exists for.

**So the design is a mix, not a replacement:** sweep cheaply to catch everyone
making noise, then spend per-account searches only on accounts the sweep never
mentions. Today it is 100% per-account.

**The test that settles it:** run a daily sweep for one week alongside the current
system, and count *accounts made draftable that the per-account path did not find*,
per dollar. Script seed: `scripts/_tmp_market_sweep.ts`.

---

## Everything else measured this session

### Efficiency
- **Exa spend is 2.9x the configured budget.** 988 searches in 7d against a ceiling
  of 8 (`searches_per_run`) x 6 ticks x 7d = 336. Eliminated: duplicate processing
  (2 near-pairs only), the reactive `agent_logic` research path (fires ~4x/week),
  contact research (zero contact research signals), `/api/research/run-now` (auth-
  gated), the local launchd loop (runs sources + agents, not the research
  dispatcher). **Remaining suspect: `selectByBuckets` budget accounting.** Needs a
  simulation against the live candidate pool, not more log archaeology.
- **187 runs in 30d spent their one search on alias resolution and then searched
  nothing.** An exploration pick gets `angle_count=1` and the resolver spends from
  the same budget. ~$2.80/month.
- **The alias resolver is ~19% of the research bill and is healthy** — 447 distinct
  accounts, zero charged twice, 362 cooled down with a marker. Do not re-flag it.
- **78% of own-site pages are byte-identical after ~29 days** (49 pages re-fetched
  through Exa `/contents`, same extractor both sides). Re-buying them is waste.
  A free conditional HTTP check (ETag / If-Modified-Since) before paying Exa is an
  untested but obvious saving.

### Quality in research
- **14% of researched accounts yield a live reason** (91 of 640 in 30d). The anchor
  bar itself rejects almost nothing extra: once a fact is dated and fresh it becomes
  an anchor. 35,894 facts were rejected as `not_an_event`.
- **Dated-event rate climbs with search spend**: 0% at 1-2 searches (274 accounts,
  zero reasons between them), 20% at 3-5, 29% at 6-10, 43% at 21+. I could NOT
  separate "bigger company" from "we searched harder" — do not claim a size effect.
- **Measure yield on pages KEPT, never pages BOUGHT.** Dividing by bought made
  `delivery_scale` look 60x worse than it is; per question it runs 4.0 kept pages
  per dated event against `recent_launch` at 2.4 and `monetization_model` at 41.7.
- **27% of kept pages carry no `answers_question`**, so any question-level rule
  governs three-quarters of spend at best.
- **OPEN, not built: a bar on datable output, not just answerability.**
  `questionsWorthSearching` retires a question no search can answer; it has no
  opinion on whether the answer can start a message. Do NOT ship it on the 14-day
  data (gathered while the planner was dead), and it needs *two* numbers — minimum
  sample and ratio — because one number produced a non-monotonic sweep (1-per-20
  retires two questions, 1-per-60 retires none).

### Quality in outreach
- **Draft quality is largely solved.** Since 2026-08-10, five of six approved drafts
  went out as written. The earlier "13 of 19 edited" figure was the whole history and
  hid the trend; both large rewrites (36%, 30%) predate the 08-14 craft work.
- **Six of the sixteen "rejections" are redraft bookkeeping**, not quality rejections.
  The real rejection rate is much lower than 39%.
- Jake's edits were craft, not fact: "too long", "reads like a news report", "you
  forgot the actual ask". Only two were substantive (a 2021 article read as current,
  fixed 08-07; and a live-broadcast scope error).
- **Same-client duplication is guarded and the guard is strict.** `loadUsedAnchorIds`
  puts every fact cited in any prior draft to that account out of bounds. Four
  accounts share a cited fact across two drafts and all four pairs predate the guard
  (08-19). Now hardened: `leadAnchor.id` is forced into `cites` (`bd0fb15`).

### Killed this session — do not revisit without new evidence
- **Silent website-change detection is dead.** 38 of 49 own-site pages byte-identical
  after a median 29 days; 0 moderate; the 3 "major" were a catalog page's tags
  reordering, a PDF's dotted leaders, and a Turkish TV schedule that changes daily.
  A first attempt using plain HTTP showed 12 "large changes" that were ALL my own
  measurement artifacts (PDFs as raw bytes, page nav reading as new content).
- **"It learns what works from replies" at Jake's current volume.** Distinguishing an
  11% reply rate from 2% needs ~100 sends per arm; 25/month are approved. **Jake's
  correction, and it is right: this is a property of his test volume, not of the
  product. A real customer at scale gets there.** Build reply capture; do not sell
  learning as a differentiator to a low-volume user.
- **The "size of company" market boundary.** I framed it as size; Jake's correction:
  it is about whether information is available online, which means mostly tech and
  some traditional businesses, not a size rule. Tested: 11 of 12 mid-size/franchise
  companies had a real dated event (Bongards' $135M expansion, Roto-Rooter's $12M
  franchise buy, Kwik Trip's land deal) at ~$0.015 each; 0 of 10 genuinely tiny
  single-location businesses had a real business event (all "hits" were LinkedIn
  profile pages and a brewery's gig calendar).
- **A one-shot "paste ten companies and I'll check them" offer.** Jake: "that's
  basically let me do a Google search. That's dumb." The product has to be trialled
  as a whole and win on setup and output.

### Works, tested, not previously proven
- **Cold start works in unrelated industries.** Two plain-English descriptions
  (dental scheduling software, industrial bearings distribution) produced sensible
  angles — `{entity} plant expansion OR new production line OR capacity increase`,
  `{entity} new plant manager OR maintenance manager OR engineering director`.
  This only works because of today's planner fix; for the previous nine days every
  new workspace would have fallen back to `BASELINE_ANGLES`.
- **Discovery works and the reason it was frozen no longer applies.** Three plain
  market descriptions returned 60+ real companies with their own domains for $0.04,
  near-zero junk. The old failure extracted entity names from *article* pages and
  produced junk like "contact" and "Not specified"; taking the **domain** off a
  *company home page* sidesteps it. Seed: `scripts/_tmp_discovery.ts`.
- **The onboarding wizard is genuinely minimal**: a name and a plain-English
  description, everything else derived. Nobody has ever run it end to end as a
  stranger — that path is untested and is the real "minimal setup" claim.

### The uncomfortable fact
Every approval decision in the system is `jaws.watson@gmail.com` — 21 recorded plus
20 predating the audit field. In four months no one but Jake has used this. 25
outreach approvals, 0 replies ever recorded, and on LinkedIn sends are manual so it
is not certain they were sent.

---

## What to do next

1. **Run the sweep for a week beside the current system.** Count accounts made
   draftable that the per-account path missed, per dollar. That is the number that
   justifies the rebalance. Everything else about the sweep is unproven.
2. **Fix the 2.9x overspend** by simulating `selectByBuckets` against the live
   candidate pool.
3. **Walk the trial path as a stranger** — new workspace, plain-English description,
   through to first draft — and time it. "Minimal setup and better output than
   anything on the market" is the value proposition and nobody has ever tested the
   first half of it.
4. Rebalance research toward sweeps, keeping per-account probing for the quiet
   accounts the sweep never names.

Scripts kept as seeds: `_tmp_market_sweep.ts`, `_tmp_discovery.ts`, `_tmp_tam_test2.ts`,
`_tmp_targeting.ts`, `_tmp_unreachable.ts`, `_tmp_planner_probe.ts`.
