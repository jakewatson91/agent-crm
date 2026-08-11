# Research quality overhaul — working log

Started 2026-08-09. Goal (Jake): stop bloating facts with irrelevant pages, stop
spending Exa dollars in vain, and make the loop good at four things end to end:
**who to research → what to search for → which facts to keep → how a message gets built
from them.** Deeper fix preferred over bolt-ons. Test target: does this beat a human
researcher on judgement, run all day, and cost less.

Workspace under test: **Sudden** (`e7052848-2270-41ac-90b6-d9b75c87f6d3`) — sells a script
that cuts CDN delivery cost for streaming companies. 2227 entities, 4124 signals,
**92,921 facts**.

---

## Measurements (7 days to 2026-08-09)

| | |
|---|---|
| research runs | 246 |
| Exa searches | 1076 (≈ $10.76) |
| signals created | 415 |
| dropped by the relevance gate | 1827 |
| dropped as stale | 507 |
| dropped for never naming the company | 780 |
| facts created from research | 795, across **488 distinct predicates** |

Facts by originating source, same window:

```
36022  no_signal (scorer breakdowns / import / system)
  795  research_result/research
   74  hiring_post/ats
```

---

## FINDING 1 (proven) — the relevance gate silently dies on the best accounts

`filterResultsByEntity` batches **every angle's candidates into one LLM call** and asks the
model to echo every page id back in `matches[]` **and** `rejects[]`. `max_tokens: 1200`.
Exa ids are long. On a rich account that is 30-50 ids echoed twice → the response truncates
→ `JSON.parse` throws → the `catch` fires.

What the catch does: **accept every own-domain page unjudged, drop every off-domain page.**

Blow-up rate against how many pages the gate was handed in one call:

```
pages 01-05   runs=63   blew=0   (0%)
pages 06-10   runs=95   blew=8   (8%)
pages 11-20   runs=40   blew=15  (38%)
pages 21-30   runs=10   blew=9   (90%)
pages 31-40   runs=10   blew=10  (100%)
pages 41+     runs=3    blew=3   (100%)
```

Perfectly monotonic in batch size. That is truncation, not model error.

**Consequence:** 45 of 246 runs (982 of 2242 pages, 44%) went through a gate that never
answered. On those runs the pipeline keeps the junk from the company's own website and
throws away the news about them. Exactly backwards, and exactly what Jake is seeing.

Corroborating counts from the same window:
- `filtered_by.unreported` = 663 of 1827 drops (36%) — the gate naming no reason.
- **77% of all created signals carry `hook_class: unclassified`** (321 of 415). Unclassified
  means no LLM judgement, which also means `HOOK_CLASS_WEIGHT` defaults to 1.0, so a help-centre
  page keeps the same magnitude as a launch announcement.

### FINDING 1 — direct reproduction (`_gq_08_gateraw.ts`, real ViX batch, 23 stored pages)

```
--- max_tokens=1200 (production) ---
  finish=length  out_tokens=4000  parsed=NO (Unexpected end of JSON input)
  accounted=0/23
  >>> catch fires: own-domain pages accepted UNJUDGED, off-domain dropped

--- max_tokens=4000 ---
  finish=stop  out_tokens=6252  parsed=YES
  matches=6 (all 6 carry a hook class)  rejects=17  accounted=23/23
     event      produ.com/.../final-del-mundial-2026-televisaunivision...
     event      imagenradio.com.mx/.../vix-suma-3-millones...
     event      dplnews.com/mexico-vix-tropieza-en-el-arranque-del-mundial...
     event      gurufocus.com/news/8913261/vix-faces-refund-calls-after-world-cup-st...
     direction  digitaltv.prensariozone.com/vix-refuerza-su-plataforma-con-foco-en-el-mu...
     profile    econify.com/project/vix
```

Note `chatComplete` already retries invalid JSON at `max(max_tokens*3, 4000)`. On this batch
**the retry truncates too** (out_tokens hits exactly 4000, finish=length), so the catch still
fires. It needs ~6250 output tokens for 23 pages.

Read the two lists together and the whole complaint is explained on one account:
"ViX faces refund calls after World Cup stream" — a **delivery failure during a peak-concurrency
event**, the single best hook a company selling delivery cost could ever get — was found by the
gate and thrown away. `ayuda.vix.com/.../Support` was kept.

**Why it costs 6250 tokens:** the model is made to echo the Exa id of every page twice (once in
`matches`, once in `rejects`), and Exa ids are full URLs. 272 output tokens per page. Replacing
the id with the page's index in the batch (0,1,2…) and mapping back locally cuts that to ~15
tokens per page — a 20x reduction that removes the failure mode instead of raising a limit.

## FINDING 2 — the `customers` angle is a website crawler with no relevance filter

Sudden's cached angle:

```
customers   own_site   recency=none   {entity} customer OR case study OR partner OR trusted by
```

`own_site` + no recency + OR-heavy = "search this company's entire website for the word
partner". A streaming company's website is mostly help centre, catalogue and legal pages.
Pages this actually bought in the last 7 days:

```
https://ayuda.vix.com/hc/en-us/articles/12229477140877-Support
https://ayuda.vix.com/hc/en-us/sections/24737693957645-ViX-Subscription-with-other-Partners
https://www.showmax.com/za/help/article/how-do-i-pay-for-showmax-using-my-mtn-airtime
https://support.m6plus.m6.fr/hc/fr/articles/13273266085788-Pourquoi-je-n-ai-pas-acces-a-M6...
https://www.sky.com/help/articles/setting-up-sky-stream
https://support.flosports.tv/en/article/9e22b8
```

Volume: `customers` + `own_launches` = **296 of 403 signals (73%)** of everything research
created this week. Both are `own_site`. Both are the scope the broken gate auto-accepts.

## FINDING 3 — the enricher has no idea what the workspace sells

488 distinct predicates from 795 facts. Median predicate has one fact. Real examples now
sitting in Sudden's fact store, for a company selling CDN cost reduction:

```
Tastemade        ad_effectiveness_brand_affinity_lift_percent = 10
Tastemade        has_award = 2021 Most Innovative Companies: Top 10 in Media
Speir On Demand  equipment_requirement = Pilates reformer and accessories required
Speir On Demand  lead_instructor = celebrity trainer Andrea Speir
Spacetoon Go     plan_pro_monthly_price = $4.99
Sport TV         linkedin_followers_growth_monthly = +0.7%
Sport TV         launched_channel = SPORT TV Golfe (2010)
CrunchyRoll      funding_rounds = 2
```

Against the one page in the sample that is actually worth the money:

```
Cineverse   streaming_viewers = 129.6 million in Q4 FY2026
Cineverse   minutes_streamed = 4.4 billion in Q4 FY2026
Cineverse   minutes_streamed_growth_yoy = 58% increase vs Q4 FY2025
```

The enricher prompt's DEPTH section says "go deep" and lists no relevance test at all. It is
told what the workspace's example fact *shapes* look like, never what the workspace *sells*,
so it cannot tell a viewer-concurrency number from a Pilates reformer.

## FINDING 4 — vocabulary sprawl means the facts are a pile of strings, not a graph

Whole book: **33,272 active facts, 1,233 distinct predicates, 977 of them used exactly once
(79%).** No cross-account question is answerable — one account holds `monthly_viewers`, another
`streaming_viewers`, a third `monthly_minutes_watched`, a fourth `streaming_subscriber_count`.
The enricher is told to reuse existing predicates; at 79% single-use it plainly does not.

## FINDING 5 — the output end: 19 drafts in 30 days, and they lead on profile facts

Last 30 days on Sudden: **19 `touch_draft` posts, 28 gates (16 approved / 12 rejected)**, against
roughly 1,000 research runs and ~4,600 searches (≈$46 of Exa). The most-cited predicate in every
draft written is `video_content_type` (53 cites) — a profile fact, the exact category the gate
prompt itself calls "the least valuable". The drafter leads on profile facts because profile
facts are mostly what survives the pipeline.

---

## Diagnosis in one line

The pipeline **extracts everything and hopes a ranker sorts it out.** Four stages filter
independently, and only two of them have any idea what the workspace sells:

| stage | what it knows about the business | verdict |
|---|---|---|
| dispatcher — who to research | score_total, tiering, yield backoff | fine, keep |
| planner — what to search for | about + ICP + pains + guidance | fine, but ships one bad angle |
| gate — which pages to keep | pains + signal_types | right idea, **breaks on big batches** |
| enricher — which facts to pull | **nothing** | the biggest hole |
| fact scorer — what to lead with | ICP embeddings | cleaning up after the mess |

A human researcher does not do this. They hold a handful of questions in their head, stop as
soon as the questions are answered, and write down nothing else.

---

---

# THE FIX — one artifact every stage reads

Jake picked the deep option on 2026-08-09, with two constraints: **generalizable across
workspaces** and **easy to debug, not too complex**. Exa test budget: $3.

## The research brief

`packages/tools/src/research_brief.ts`. A workspace's brief is 3-7 questions, written by
the model from that workspace's own About/ICP/pains/guidance, stored on
`policy.research.brief`. Neutral `BASELINE_BRIEF` when there is nothing to plan from.

| stage | what it does with the brief |
|---|---|
| planner | writes one angle per question; every angle carries `answers: <question_id>` |
| gate | keeps a page only if it answers one, and records **which** |
| enricher | fills that question's slot, extracts nothing else |
| drafter | unchanged — it just gets far less noise |

**A question id is also the predicate namespace.** Question `scale` owns every `scale.*`
predicate. The prefix is fixed by the brief, only the suffix is the model's to pick. That
is what collapses the 1,233-predicate sprawl, and it makes cross-account questions work:
`predicate LIKE 'scale.%'` instead of guessing four spellings.

No migration — `facts` has no metadata column, and namespacing the predicate needs none.

### Generalizable (constraint 1)
- Questions are generated per workspace from its own text. No vertical terms in code.
- `BASELINE_BRIEF` names no industry: moves / scale / buyers / stack / voice.
- The gate's reject list is web furniture (help centre, FAQ, pricing, terms, login,
  app-store listing, profile page), universal, not vertical.
- Lives on `workspaces.policy`, so a customer edits it without a code change. No new env vars.

### Debuggable (constraint 2)
One command, `scripts/research_explain.ts "<account>"`, prints the whole chain: brief →
angles → pages kept/dropped with reason → facts grouped by the question they answer. The
failure names itself — a question with no angle is a coverage gap, an angle whose pages all
say `no_answer` is a bad query, a kept page with no facts is an extraction miss.

The gate also got **simpler**: two tests instead of three, no `hasRelevance` branching, no
own-domain auto-accept path.

## Changes that were bugs, not design

1. **Gate batching.** Pages are addressed by index (`#0`, `#1`), not by echoing their Exa
   URL twice. Batch capped at 10. ~150 output tokens per batch against a 1200 budget,
   roughly 40x margin, where it used to need 6252 and get 4000.
2. **Fail closed.** A batch the gate cannot read is dropped, not guessed at. The old catch
   accepted every own-domain page unjudged, which is how a company's help centre outranked
   its launch blog.
3. **`temperature: 0` on the gate.** Two runs over the same 23 ViX pages kept 10 and then 7.
   Classification should not be a coin toss. Residual variance is now ±1 page.
4. **One `resolveBrief`, not two.** There was briefly a `resolveBriefWithPain` as well, and
   the gate ended up on the version without it — so a page reporting a company's service
   buckling under load answered no question and was dropped. One reader, no way to pick wrong.
5. **Brief stability.** The brief regenerates only when its INPUTS change (`brief_input_hash`),
   never on a timer, and a regeneration is shown the previous questions and told to keep ids.
   Caught live: two runs from identical About produced different question sets, which would
   have orphaned every fact under the old names. Verified: a regeneration preserved all 4 ids.

---

## Results so far

### Gate, replayed on real stored pages (no Exa spend)

ViX, 23 stored pages — the account Jake complained about:

```
BEFORE: response truncated, catch fired, 9 ayuda.vix.com help pages kept,
        every off-domain page dropped including the World Cup story
AFTER:  kept 7, dropped 16 (16 no_answer, 0 unreported, unreadable_batches=0)
```

All 9 `ayuda.vix.com` help pages dropped as `no_answer`. Kept, with the question each answers:

```
peak_concurrent_viewers  event   produ.com/...final-del-mundial-2026...alcanza-305-millones
peak_concurrent_viewers  event   gurufocus.com/...vix-faces-refund-calls-after-world-cup-streaming-glitch
peak_concurrent_viewers  event   dplnews.com/mexico-vix-tropieza-en-el-arranque-del-mundial...
delivery_cost_talk       event   deadline.com/...world-cup-televisaunivision-q2-earnings...
recent_launches          event   digitaltv.prensariozone.com/vix-refuerza-su-plataforma...mundial-2026
pain                     direct  expansion.mx/...vix-no-quiere-canceles-cuenta-estrategia
```

Across 6 accounts, 90 stored pages: kept 13 (14%), 76 dropped `no_answer`, 1 `identity`,
**0 unreported, 0 unreadable batches**. The low keep rate is the finding, not a regression —
the stored corpus is mostly what the broken gate wrongly admitted.

Two fixes came out of reading the per-page verdicts rather than the totals:
- The first pass dropped the World Cup delivery-failure story. Cause: `pain` was reaching the
  enricher but not the gate. That page is the most valuable one there is.
- The first pass also kept a bare LinkedIn profile page. The prompt now separates a person's
  profile (job title, answers nothing) from something that person wrote or said.

### Enricher, replayed on real stored pages (no Exa spend)

On four URC TV support pages the old prompt wrote `airplay_apple_tv_recommendation` and
`app_os_requirement`; the new one wrote **nothing**, which is correct.

On Cineverse content pages, old 1.5 facts/page vs new 0.3, and 100% of new predicates landed
inside a brief slot. But this exposed a real cost: the old prompt caught
`content_library_size = over 66,000 films`, which the brief at the time had no question for.
Fixed by strengthening the brief prompt so every problem the seller lists must be reachable
by a question; the regenerated brief now carries a catalogue-size question.

**This is the main risk in the design and it is worth stating plainly: the brief's quality
determines everything downstream.** A brief that misses a topic silently stops collecting it.
Mitigations are that the brief is visible and editable on policy, and `research_explain.ts`
prints unanswered questions.

### Live A/B — fresh searches, same 6 accounts (ViX, Sky Stream, Tastemade, Sport TV, Cineverse, ShowMax)

Run 1, 30 searches (≈$0.30), read off the `research_completed` markers:

| | before (436 runs, 1941 searches) | after (6 runs, 30 searches) |
|---|---|---|
| pages reaching the gate | 2935 | 190 |
| kept | 681 (23%) | 25 (13%) |
| dropped, reason given | 1316 identity, 0 no_answer | 18 identity, **120 no_answer** |
| dropped, **no reason** | **938 (32%)** | **27 (14%)** |
| gate-unreadable batches | n/a | **0** |
| kept with no hook class | **63%** | 44% |

Truncation is gone: `gate_unreadable = 0`, and the reasonless-drop rate fell 32% → 14%.
Every kept page now names the question it answers:
`{"pain":5,"catalogue_size":4,"leadership_statement":2,"cdn_delivery_stack":2,"regional_expansion":1}`.

Two defects the live run exposed, both fixed after it:

1. **27 pages the model listed in neither array.** Bucketed as `no_answer` now (which is what
   it means in practice) and counted separately as `omitted`, so sloppiness stays visible
   without being confused with an outage.
2. **11 of 25 kept pages came back with no hook class**, and unclassified meant FULL magnitude
   (`HOOK_CLASS_WEIGHT[...] ?? 1`). So "keep this but I won't say why" outranked a judged
   launch — the same shape as the original bug. A classless keep now falls to `profile`, the
   lowest weight.

Also: gate batches now run in parallel. Capping at 10 turned one LLM call into up to five,
and serially that added about a minute to every run on a well-covered account — the accounts
worth the most.

## Status

- [x] Confirm Jake's report against live data
- [x] Prove the gate truncation (correlation + direct reproduction)
- [x] Measure fact vocabulary sprawl and draft output
- [x] Agree the fix shape with Jake
- [x] Implement brief + planner + gate + enricher + dispatcher wiring
- [x] `pnpm verify` green
- [x] Replay A/B on stored pages (gate, enricher)
- [x] Live A/B run 1 — truncation gone, two defects found and fixed
- [x] Live A/B runs 2 and 3 — `unreported: 0`, `gate_omitted: 0`, `gate_unreadable: 0` on every account
- [x] Found and closed a real brief gap using the drop sample (see below)
- [x] `pnpm verify` green after every change
- [ ] Report to Jake  ← HERE

### Run 3 (final), 3 accounts, 15 searches

```
Cineverse   searches=5 kept=0 dropped={identity:0, no_answer:24, unreported:0} unreadable=0 omitted=0
ViX         searches=5 kept=1 dropped={identity:8, no_answer:14, unreported:0} unreadable=0 omitted=0  per_question={delivery_scale:1}
Sport TV    searches=5 kept=1 dropped={identity:0, no_answer:14, unreported:0} unreadable=0 omitted=0  per_question={pain:1}
```

Total Exa spent across all testing: **~$0.90 of the $3 budget.**

### The brief gap, found and closed

The gate dropped `streamingbetter.com/cineverse-ended-march-2026-with-more-than-1-5-million-svod-subscribers`
as `no_answer`. That page carries **129.6M viewers, 4.4B minutes streamed, 58% YoY growth** — the
best page in the sample for a seller of delivery capacity.

The gate was right. The brief only asked about *peak concurrent* viewers and *catalogue size*, so
Sudden's second and third stated pains (total views against a fixed yield, traffic outgrowing the
team) had no question at all. The must-include term ("peak concurrent viewers") had anchored the
planner onto the narrowest possible version of the number.

Fixed in the brief prompt: a must-include names the BEST version of a figure, never the only one
worth having, so a brief that asks for a peak must also ask for the plain running total — the peak
is published rarely, the total constantly. The regenerated brief carries `delivery_scale`
("total views, hours streamed, or active viewers, and how fast that is growing") alongside
`peak_concurrent`, and the page is kept again as `delivery_scale` / `event`.

**This is the failure mode to watch.** A missing question is silent: research keeps running, keeps
paying, and quietly discards the right answer. Two things make it visible:
`research_explain.ts` prints unanswered questions, and the run marker now carries a `drop_sample`
of up to 8 discarded pages with the angle and reason, so "should that have been kept?" is one
command instead of re-running the searches.

### 2026-08-09 (late) — the naming scheme was torn out, and the brief can now improve

Jake pushed on two things and was right on both: the design was overcomplicated, and "the brief can
change" is not the same as "the brief gets better."

**Torn out.** Making a question's id a permanent prefix on every fact name it produced was the one
decision that dragged in everything else — the input hash, the id-continuity prompt, the embedding
match idea, retired-question lists, a migration and a new column. All of it existed only to protect
stored fact names from a question being renamed. Cutting the prefix deleted all of it.

Two checks decided it:

- **Where the junk reduction actually came from.** Telling the extractor the questions and saying
  extract nothing else. On four support-page URLs the old prompt invented
  `airplay_apple_tv_recommendation` and `app_os_requirement`; the brief-aware prompt extracted
  nothing, correctly. No naming scheme involved.
- **The fallback I nearly shipped was worse.** I proposed "just join through the page record"
  instead — then measured: **2,376 of 96,241 facts (2%) have a `signal_id`**. That design would
  have left 98% unattributable. Checking before committing is the only reason it did not ship.

Fact names are flat again. `normalizePredicate`, `splitPredicate` and the dotted scheme are gone.
`research_explain.ts` now groups facts by the question the PAGE they came from answered, which
survives a question being reworded or retired — verified live: `catalogue_size` and
`leadership_statement` render as `RETIRED — facts kept and still readable`.

**How the brief improves.** Regenerating from About is re-rolling dice, not learning. Each question
now carries a track record, computed from data already stored — no new storage:

```
question              searches  fetched  kept  hit%  facts  used   verdict
recent_launch                1      ...    13    ..%    20     0   ...
pain                         -        0    16    0%     44     0   no search points at it
catalogue_size               -        0     5    0%     16     0   RETIRED — facts kept
```

The columns diagnose **different** failures, and keeping them apart is the whole point:
`fetched high / kept low` is a bad SEARCH, not a bad question. `kept high / facts 0` is extraction.
Only `facts high / used 0` justifies retiring. Conflating them is how a good question gets deleted
because someone wrote a bad query — the exact mistake I made by eye earlier today when I nearly cut
the best-performing angle.

That scorecard is fed into regeneration, with guardrails. Tested on three deliberately different
shapes, 3 runs (`scripts/_gq_22_evolve.ts`):

```
A  bad search (220 seen, 4 kept, 0 used)   -> survived 3/3  (correct)
C  unproven  (6 seen, 2 kept, 0 used)      -> survived 3/3  (correct)
B  dead      (180 seen, 140 facts, 0 used) -> dropped  3/3  (correct)
```

Ids are preserved for survivors, so a question's record is not reset by a rewording.

Added `per_angle_fetched` to the run marker: without it, "kept 0" reads identically for "the web has
nothing" and "the query is wrong", which are opposite fixes.

**Kept, and why:** `brief_input_hash` (detects an About change — the regeneration trigger) and
id-continuity prompting (a question's track record is filed under its id). Both are now cheap
conveniences rather than load-bearing.

### FINDING 9 (fixed) — the scorecard's commonest verdict had nothing that could act on it

The scorecard flagged `technical_leader` at **183 fetched, 0 kept in one day**, the largest search
volume of the day. A handoff note called it "a five-minute reword" of the LinkedIn query. It was
none of those things.

**It is not a wording problem.** `buildAngleRequest` sends `include_text: [entity_name]` on the
social scope, and the most common page on linkedin.com containing a company's name is an
**employee's profile card**. Of 213 sampled drops, **170 were `linkedin.com/in/` profile URLs**,
which is why the drops split 145 `no_answer` / 68 `identity` — Exa was correctly returning pages
that mention the company, and they were profiles. `research_strategy.ts:82` already documented this
for `resolveContactStrategy`; the company path never got the same reasoning, and
`socialScopeAddendum` was ordering "Include exactly ONE social angle" in every workspace.

**It is not hand-fixable either.** Angles live in `policy.research.strategy`, which
`persistResearchStrategy` treats as a 14-day cache. A hand-reworded query reverts silently.

**The real gap.** `research_brief.ts` hands a track record to the BRIEF planner and tells it
"the SEARCH is finding the wrong pages, rewrite its query" — but the brief planner writes
QUESTIONS. `research_strategy.ts`, which writes the queries, received no performance data at all.
The verdict the scorecard reaches most often was routed to the one component that could not act on
it.

Fixed by giving the query planner the same feedback the question planner already had:

```
linkedin_leadership        183 seen,  0 kept  (0%)  -> CANNOT work as written
cdn_provider_mentions       71 seen,  5 kept  (7%)  -> rewrite it
customer_case_studies      139 seen, 15 kept (11%)  -> earning its place
recent_launches_news       141 seen, 56 kept (40%)  -> earning its place
monetization_revenue_news   24 seen              -> TOO EARLY TO JUDGE, keep as is
```

Three runs (`scripts/_gq_26_anglerecord.ts`), all five brief questions served every time:

```
social angle back?        no  3/3   (rewritten to news/open_web, id kept)
monetization_model kept? yes  3/3   (survived on the 30-page fair-trial guard, not on praise)
```

`monetization_revenue_news` is the point. A planner run **without** the record dropped the
workspace's best angle (71% hit) outright. Sample size, not merit, is what saved it — which is
exactly what the guardrail is for.

**Two defects found while building it.** `query_template` was hard-sliced at 200 chars, so a planner
run shipped `... (said OR explained OR desc` to Exa: an unclosed OR-group with half a word in it.
`clampQuery` now cuts on a word boundary and drops any group or quote left hanging.

And the id-continuity rule collided with itself. The record is filed under the angle id, and the id
is kept across a rewrite so the record survives — which meant the rewritten `linkedin_leadership`
(now a `news` search) **inherited the 183/0 record of a query that no longer exists**. The next
planner run would be told a brand-new query "CANNOT work as written". `record_since` is stamped when
`query_template` or `domain_scope` changes and carried forward when they do not, and the scorecard
now prints a line under any question whose search was rewritten inside the window, so the day after
a fix the row does not read as though the fix failed.

**Still open, deliberately.** Correction only fires at regeneration, so a newly-bad angle can burn up
to 14 days of searches first — roughly 2,500 pages at Sudden's rate. A dispatch-time skip for an
angle sitting at 0 keeps past the fair-trial threshold would close it. Separately,
`coerceAngle` hardcodes `enabled: true` and `persistResearchStrategy` overwrites the whole array, so
a human's per-angle off switch comes back on within 14 days, in every workspace.

### FINDING 8 (fixed) — encyclopedia articles were walking straight through

Caught on the last verification run, on accounts never researched before, while I was one paragraph
away from calling the work finished:

```
facts=11  q=recent_launch  class=event  https://en.wikipedia.org/wiki/NHL.TV
```

Kept, classed as an **event**, and mined for eleven facts: `original_launch_year = 2008`,
`renamed_to_nhl_tv_year = 2016`, `picture_format = 2140p`, `sister_channel = NHL Centre Ice`. That
is the original complaint, alive and well. `en.wikipedia.org/wiki/Watcha` had done the same thing
earlier in the day and I had not chased it.

A wiki article is the exact shape the substance rule exists to reject — it restates what is already
known — but the wording named "directory listings, aggregators, company-profile pages, databases"
and an encyclopedia article does not read like any of those. It reads like a substantive write-up,
because it has history, dates, ownership and product names. That is the trap.

Fixed in the gate prompt by naming the SHAPE, not the site: if the page's job is to summarise what a
thing IS, reject it whatever question it appears to touch. Vertical-neutral, no host list.

Verified by replay on stored pages, no Exa:

```
NHL.TV     wikipedia now dropped (no_answer); the real Prime Video partnership announcement kept
6 accounts, 111 pages: kept 32 (29%), up from 13 of 90 (14%). identity drops still 2.
```

Keep rate went UP, so the rule cost nothing broadly. One page moved the wrong way on a 4-page batch
(an NHL production-economics story now dropping on identity) — single-page judgement, not a pattern,
noted rather than chased.

**The lesson worth keeping: the last check before declaring done is the one that found it.** Both
earlier "final" runs used accounts already researched three times that day, where the 30-day
cross-run dedup had exhausted the fresh material — 1 page from 10 searches. A verification run on
drained accounts proves almost nothing. Test on accounts that have never been touched.

### FINDING 7 (superseded) — the namespace rule was obeyed about half the time

First full end-to-end run (6 accounts, 23 pages, 47 content facts, 2.0 facts/page against the old
1.5-19). The facts that landed in slots were the right ones:

```
pain.network_usage_fees   Watcha's collapse attributed to Korea's "traffic curse" — network usage fees
technical_leader.*        SVP of Product on cloud economics in live production (SVG Summit)
audience_scale.*          VBTV: 1.72 billion cumulative viewers across 80 territories
audience_scale.*          TV2 Play: 1.3 million subscriber target, ~650k today
```

But **21 of 47 came back flat** — `content_addition`, `founder`, `pain_observed` — so the same idea
sat in two vocabularies at once and the namespace bought nothing. `pain_observed` appearing next to
`pain.*` is the clearest example.

It also produced a false alarm I nearly escalated: `cdn_infrastructure` and `monetization_model`
showed 0 facts, which read as a brief-coverage gap. It was not. Both questions got pages, and the
Watcha page produced 2 facts — they just landed flat (`founded_date_company`, `founder`) and fell
into the off-brief bucket. Same defect, different column.

**Fix: stop asking the model.** The gate already decided which question each page answers and wrote
it on the signal, so the slot is known without the model's cooperation. `normalizePredicate` in the
enricher's assert loop prefixes any flat predicate with the signal's `answers_question`, strips an
invented slot back to its detail before re-prefixing, and leaves everything alone when there is no
brief or no question on the signal. Deterministic, lossless, and compliance becomes a property of
the code rather than of the prompt.

### FINDING 6 (fixed) — the dispatcher was tiering the whole book on first-ever scores

Found while checking why my own test script picked Uplynk at 0.68 when its stored `icp_fit` is 0.34.

`entity_research_dispatcher.ts` loaded `icp_fit`, `score_total`, `score_signal_strength` and
`dropped_until` with `.is('supersedes', null)`. A rescore writes the **new** row carrying
`supersedes=<old id>`, so the row whose own `supersedes` is null is the **first-ever** score and its
value never moves again. The dispatcher decides who gets researched, so "who to research" was being
answered from numbers that could be months old.

Measured before the fix (`scripts/_gq_19_tierdrift.ts`, Sudden, 2133 accounts):

```
dispatcher value == current value : 238  (11%)
value differs                    : 1895 (89%)
lands in a DIFFERENT tier        : 134  (6%)

tier moves:  57 hot->cold   32 hot->default   27 default->cold   13 default->hot   5 cold->default

hot accounts being researched weekly or monthly instead of daily:
  RTVE        reads 0.38  actual 0.87
  Qalbox      reads 0.34  actual 0.84
  JustWatch   reads 0.47  actual 0.79
```

So the loop paid for daily research on 57 dead accounts while visiting the best ones monthly.

**This trap is already documented and fixed elsewhere in the repo** — `reads.ts:216` and
`system_tasks.ts:105` both carry comments naming the exact failure. The dispatcher was missed.

Fix: drop the filter, keep the row no other row supersedes (latest `observed_at` breaks ties).
That means reading every version of four predicates, ~18 rows per account, so a 200-account chunk
is ~3600 rows and blows past PostgREST's 1000-row cap — which is the failure the wrong filter was
masking. Added `chunkedInPaged` and paged the read.

Verified (`scripts/_gq_20_verifytier.ts`): **1000 of 1000 accounts now read the current value, 0
tier mismatches, 0 lost to paging**, 13,743 rows read where the unpaged version capped at 1000.

### RESOLVED 2026-08-09 — the fix was in About, not in config

Jake's call, and it was right: if simultaneous audience is what makes the product pay, it belongs in
the workspace's own description, not in a `always_include` override.

About described the MECHANISM ("viewers who are already watching share pieces of the video with each
other") but never the CONDITION — nothing said the savings scale with how many people watch the same
thing at the same time. So no reading of About could point at simultaneous audience as the number to
hunt for, and someone had bolted on an override to force it.

One sentence added to `workspaces.about`:

> The more people watching the same thing at the same time, the more the viewers can hand to each
> other, so the savings are biggest on a large simultaneous audience for one title and smallest when
> everyone is watching something different.

Effect on the brief planner, three runs from **About alone, no override**:

| | before the About edit | after |
|---|---|---|
| dedicated peak-concurrency question | **0/3** | **3/3** |
| broad volume question | 3/3 | 3/3 |

`research.always_include` deleted. Brief and angles regenerated and persisted; all five questions
have an angle. Nothing about the loop is workspace-specific any more — the description carries it.

### CORRECTION 2026-08-09 — I blamed `always_include`, wrongly

I reported that Sudden's `research.always_include` had anchored the planner onto the narrowest
version of the audience number. Two things wrong with that.

**It is not Jake's setting.** It was added on 2026-08-04 in a prior session on this repo;
`research_queries_review.md:99` records why (the product needs simultaneous viewers, and the floor
below which the swarm does not form is unknown — a number to collect, not a veto condition).

**It is not the cause, and it earns its place.** Measured with `scripts/_gq_15_briefinputs.ts`,
three planner runs per input set:

| input set | broad volume question | dedicated peak-concurrency question | ids repeated in all 3 runs |
|---|---|---|---|
| About only | 3/3 | **0/3** | 0 of 12 |
| About + icp + pains + guidance + always_include | 3/3 | **3/3** | 0 of 13 |

Both get the volume question every time — the anchoring was fixed by the "ask broadly how much"
prompt rule, not by removing inputs. Dropping `always_include` would lose the only reliable source
of the peak-concurrency question, which is the genuinely product-specific thing prose cannot infer.

**The real defect the test exposed: question ids are the least stable thing the planner emits.**
Zero ids repeat across three runs in either configuration — `cdn_providers` / `delivery_stack` /
`cdn_provider`, `streaming_scale` / `video_scale` / `streaming_volume`. Same questions, new names
every time. And the id is the permanent predicate namespace, so the least stable output became the
most permanent thing in the data model.

Already guarded: the brief regenerates only when its inputs change (`brief_input_hash`), never on a
timer, and a regeneration is shown the previous ids and told to keep them (verified: all 4
preserved). A real workspace generates once at setup. The churn during this session was
self-inflicted — I cleared and regenerated the brief roughly six times while tuning the prompt, and
each pass renamed every slot.

**Decision: leave the brief inputs alone.** About + `always_include`, ids frozen at first generation.

### Remaining waste, now measurable: the social angle

The drop sample named it immediately. Cineverse's last run, all 8 sampled drops from one angle:

```
dropped[no_answer] via exec_statement: Laura Morrison    linkedin.com/in/laurarmorrison
dropped[no_answer] via exec_statement: Sudipta Ghorui    linkedin.com/in/sudipta-ghorui-673a0233
dropped[no_answer] via exec_statement: Derek Powell      linkedin.com/in/dpowell98
dropped[no_answer] via exec_statement: David Ehrlich     linkedin.com/in/dmitchell789
```

Bare profile pages and unrelated people's networking posts. One angle in five, so ~20% of the
per-account search budget, buying nothing on every run. `research_queries_review.md` flagged this
on 2026-08-04 as unresolved; it is now visible from one command rather than a research project.
The gate rejects them correctly, so this is Exa spend, not data quality. **Not fixed — needs a
decision from Jake**, since the obvious fix (drop `/in/` profile URLs before the gate) means a
URL-pattern list in code.

### FINDING 10 (fixed) — the correction loop had no exit, and its denominator was wrong

`technical_leader` had been rewritten twice and still answered its question roughly 0 times in 264
pages. Nothing in the system could conclude "no web search can answer this": a failing angle is
rewritten, the rewrite resets that angle's `record_since`, the fresh record reads TOO EARLY TO
JUDGE, and the question is searched for again. The brief planner cannot break the tie either — it is
told, correctly, that a low hit rate means the SEARCH is wrong and never the question. Both readings
are right per attempt. Neither can look across attempts.

**One rule, stated once, applied at two altitudes.** A search must answer the question it was bought
for at least once per fair trial (30 pages) — `earnsItsSearches`, the only bar in the loop now.

- Applied to one ANGLE past a fair trial: the query gets rewritten. This replaces `kept === 0`, which
  was the only number a single accident could move: the live angle sat at 1 answer in 264 pages and
  was permanently immune to correction while it went on spending.
- Applied to a QUESTION past five fair trials (150 pages): no search answers it. Stop buying them.

**What happens to a condemned question is not retirement, and that is the whole design.** It stays in
the brief, so the gate keeps checking pages against it and the enricher keeps filling its slot. It
simply stops having searches bought for it. That is exactly how `pain` already works, and pain is the
most valuable thing research finds — nobody searches for it, it is noticed on a page fetched for
something else. "Cannot be searched for" and "not worth knowing" are different facts.

Withholding the question from the planner IS the enforcement (`questionsWorthSearching`). No new
switch to read, get wrong, or carry across a regeneration. Nothing is persisted, so nothing can go
stale or disagree with the scorecard, and the verdict reverses for free two ways: the 30-day window
rolls, so a dead question's spend ages off and it gets one ~150-page probe a month in case the web
changed; and if the gate ever files a page under it from a search bought for something else, the bar
is met immediately.

**The denominator was wrong, and it nearly condemned a good question.** First live run flagged both
`technical_leader` (264/1) and `delivery_scale` (216/1). The second was a false positive. `kept` is
stamped on the signal with the question id live at gate time; `fetched` was reconstructed by summing
run markers of whichever angles serve the question NOW. Sudden's brief was regenerated that day, so
every question id was hours old while its denominator spanned a month of a predecessor question's
spend — a numerator and denominator that did not start at the same moment.

Two fixes, and the asymmetry is deliberate — both halves err toward leaving a question searchable:

- The runner writes `per_question_fetched` on the run marker, charging each page to the question at
  the moment it is bought. Survives every rewrite, and every id change, in between.
- Reconstruction from old markers counts only from `brief_generated_at`. Nothing can have answered a
  question before it was written. NOT applied to `kept`: a regeneration usually preserves an id, so
  clamping answers would shrink the numerator and condemn a question that was working.

Proven live (`_gq_29`, 5 Exa searches): runner writes it, the events row stores it, and the fold
reads it back with the brief floor set to now so reconstruction is impossible.

```
returned/stored per_angle_fetched    = {"customer_case_studies":4}
returned/stored per_question_fetched = {"delivery_scale":4}
MATCH — every page bought is charged to the question it was bought for
```

Proven live (`_gq_30`, 12 planner runs): a withheld question got **0 angles in 12 runs**, every angle
named its question, and coverage of the shown questions was 4/4 every time.

**Three defects found while building it.**

1. **A planner error overwrote a working strategy with the baseline.** 1 run in 12 fell back.
   `BASELINE_ANGLES` answer `moves`/`buyers`, which no generated brief contains, so every angle in
   the workspace would buy pages for a question nobody asks — and read as orphaned, forcing the same
   failing regeneration again, every tick. The baseline is right for a workspace that never had a
   strategy, not for one whose planner call timed out. Same trap in `ensureResearchBrief`, worse:
   it would replace tuned questions with the generic five AND stamp a fresh input hash, so nothing
   would ever try again. Both now keep what is in place.
2. **A human's off switch on a QUESTION came back on every regeneration.** The identical hole that
   was fixed for angles; the brief has carried it the whole time.
3. **An assertion that could never fail.** "a keep rate under 10% says rewrite" tested
   `.includes('rewrite it')` against the whole prompt block, and matched the word "rewrite **it**s
   query" in the boilerplate footer. It held whatever the verdict said. Now tested against the
   per-angle verdict line only.

Also: `answers` is now required in `coerceAngle` when a brief exists, because an unattributed angle
spends on every account forever and appears in no question's record — and arriving with no question
is the one way a withheld question could get an angle anyway. `MIN_SAMPLE_FETCHED` /
`MIN_ANGLE_FETCHED` were two copies of the same 30 in two files; there is one `FAIR_TRIAL_PAGES` now.

Cost of the whole verification: ~10 Exa searches (~$0.10) and 15 planner calls.

## Not done / known open

- **The 33k facts already stored are untouched.** They keep their old flat predicates and read
  back fine; `research_explain.ts` shows them under `(no slot)`. Migrating them was option 3
  and Jake picked option 2 — worth revisiting once the new scheme has run a while.
- **Enrichment cannot be tested from a laptop.** Local runs report
  `enricher dispatch failed: 401 Event key not found`, so the live runs create signals but no
  facts. The enricher change was A/B'd by replay instead. Production's 15-minute
  `recoverUnmatchedSignals` cron will pick these up.
- **The brief's first generation is one non-deterministic LLM call**, and five runs produced five
  different question sets. Once persisted it is stable (verified), and it is visible and editable
  on policy, but the quality of the whole loop rests on it. Treat it like the ICP: something a
  human reviews at setup.
- **`peak_concurrency` / `catalogue_library_size` are `own_site` with no recency**, the same shape
  as the old `customers` angle that trawled help centres. The gate now catches what they drag in,
  but they are still buying pages we discard. Watch `no_answer` per angle.
