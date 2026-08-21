# Design: a job posting is a dated event, not a document to mine

Status: the fact assertion is built (2026-08-21). Role filtering already existed.
Board coverage turned out to be already built and already finished, and the answer
it gave changes how much this is worth on Sudden — see "What building it found".
2026-08-20.

## The measurement

60 days on Sudden, both signal types already in the database, no spend to check:

```
research_result   2,310 signals / 298 accounts -> 320 dated facts on  91 accounts
hiring_post         356 signals /  16 accounts ->   0 dated facts on   0 accounts
```

**Zero.** Not one job posting in 60 days produced something the drafter could open
on. What they produce instead: `technology_stack`, `uses_perl_for_core_systems`,
`network_capacity_tbps`, `headquarters_location`, `industry`. The enricher reads a
job post as a document to scrape the company's static attributes from, and discards
the only fact that matters — that on a specific date this company started paying to
solve a specific problem.

The signals already carry everything needed:

```json
{"kind":"hiring","job_title":"Engineering Manager - CTV Platforms",
 "role_family":"engineering","job_location":"New York","ats_slug":"tegnainc",
 "ats_provider":"greenhouse","dedup_key":"gh:5215083007","job_url":"..."}
observed_at: 2026-08-19
```

The connector diffs the board and dedups on the ATS job id, so a new signal means
the role *appeared*. `observed_at` is therefore a usable event date, accurate to
the polling interval.

## Why this matters more than the news path

Measured earlier this session: news gives a usable reason for **14%** of researched
accounts, and skews hard to the loud — the accounts it lit up were Netflix, Comcast,
ESPN, Amazon, Disney+. 86% of the book is silent because journalists do not write
about mid-size companies.

Job postings have the opposite shape:

| | news | job postings |
|---|---|---|
| covers quiet companies | no | yes, if they are growing |
| cost per company | $0.015/search | free (public ATS boards) |
| states the problem | rarely, indirectly | explicitly, in the title |
| dated | sometimes, and publishers lie | yes, by board diff |
| cadence | when something is newsworthy | continuous |

For Jake's stated market — companies whose information is online, mostly tech —
ATS adoption is close to universal. **The cheapest signal source available has the
best coverage of the exact market being sold to, and today it yields nothing.**

## The second-order signal, which is the actually novel part

A job posting is a buying window opening **before it opens**. "Director, Product
Security" means that in roughly 60 days a person exists with that title, a budget
and a mandate. UserGems and everything like it track people who have *already*
moved, which is the same signal arriving late and after the budget is committed.
Tracking the vacancy is earlier, cheaper, and nobody sells against it.

It also names the buyer before they arrive: the role title is the job description
of the person who will own the problem.

## Build

**1. Assert the hiring event (small).** In the enricher path, when
`structured_tags.kind === 'hiring'`, assert a fact directly rather than relying on
extraction from the description:

```
predicate    hiring_role
object_text  "Engineering Manager - CTV Platforms (New York)"
happened_at  signal.observed_at        <- the whole fix
confidence   0.95
```

Keep the existing attribute extraction; it is not harmful, it is just not an event.
This alone turns 356 dead signals into anchor candidates.

**2. Make role relevance config, not code.** `policy.hiring_filter` already exists
(`include_families`, `include_seniorities`, `exclude_families`,
`always_include_exec`). The brief should decide which roles are a reason to write:
for Sudden, anything naming video, delivery, CDN, streaming or platform
infrastructure. A big company posts hundreds of roles and most are noise, so the
filter is what stops this becoming spam. Vertical-neutral by default, per the
portability rule.

**3. Coverage is the real work.** ~~Only 16 accounts produced hiring posts in 60
days because the ATS source watches a fixed slug list.~~ Wrong, and the correction
is the most important thing in this document — see below. The connector already
discovers boards by itself and has already been round the whole book.

**4. Then the anchor works unchanged.** `pickAnchorCandidates` needs a dated fact
inside the freshness window and nothing else. A `hiring_role` fact with
`happened_at` set qualifies with no change to the anchor, the drafter or the gate.

## Failure modes

1. **Volume from big employers.** Netflix posts hundreds of roles. Without the role
   filter this floods the book with one account. The filter is not optional.
2. **`observed_at` is first-seen, not posted-at.** A board added to the watch list
   today will emit its entire backlog as "new". Needs a first-run suppression:
   on a newly resolved ATS slug, seed the seen-set without emitting. The ATS
   connector already keeps a seen-jobs cache for exactly this reason (it was fixed
   on 2026-06-24 after boards with >200 roles re-emitted their overflow).
3. **A role is weaker evidence than an announcement.** "Hiring a CTV engineer" is a
   hypothesis about their priorities; "launched a FAST channel" is a fact about
   their business. Expect a lower reply rate per anchor and treat hiring anchors as
   a distinct class so the two can be compared once reply capture exists.
4. **ATS coverage is not universal.** Broadcast and international operators — much
   of Sudden's book — are less likely to use Greenhouse or Lever than a US SaaS
   company. This idea is strongest for exactly the market Jake named (tech) and
   weakest for Sudden's current one, which is worth knowing before judging it on
   Sudden's numbers.

## What building it found

**The fact assertion works exactly as predicted.** Replayed against all 356 stored
job postings before deploying: every one of them now produces a dated
`hiring_role` fact. Not near 1:1, actually 1:1. 182 of the 356 land inside the
30-day anchor window.

It also picks a better date than this document proposed. Boards mostly state their
own posting date, and 255 of the 356 are older than the day our diff first saw the
role, so that date is used instead. The rule is the older of the two wins, which
is the same asymmetry `applyContentDate` already applies to article datelines: a
date may move a thing older, never newer. Greenhouse is the reason for the second
half — it reports last-updated rather than first-published, so a posting edited
yesterday would otherwise re-date itself forward into the freshness window every
time someone fixed a typo in it. This also defuses failure mode 1 below on its own:
a backlog emitted the day a board is discovered keeps its real age, so a two-year-old
vacancy never reads as this morning's news, and no first-run suppression is needed.

The assertion runs before the burst-collapse guards, not after. Those guards exist
so a company with 40 open roles doesn't fire 40 thirteen-thousand-token model
calls, and they are right to, but this fact costs no tokens, and a role dropped by
the burst collapse is exactly the one worth dating.

**Board coverage is 1.2%, and it is not fixable by building anything.** The
connector has done lazy per-account discovery since it was written, caching the
result on `entities.attributes.ats`. Every one of Sudden's 1,961 live accounts has
already been probed. 24 have a board: 10 Greenhouse, 8 Lever, 6 Ashby. 1,937
returned nothing. There is no daily slug resolver left to build, because it exists
and it has finished.

So failure mode 4 below is not a risk any more, it is the result. Broadcast and
international streaming operators do not post to Greenhouse. One caveat on the
1.2%: 600 of those accounts carry no domain, and without one the connector can only
guess a slug from the company name, which is the weaker path. The true ceiling is
somewhat above 24, not multiples of it.

**What that means in accounts.** Sudden today has 90 accounts of 1,961 holding a
dated fact fresh enough to write on. Fresh hiring anchors exist on 8 accounts, 7 of
which had no other reason to be written to. So this is +7 on 90.

The change is still right and still cheap. It is the only way a hiring anchor's
reply rate ever gets measured, and it costs nothing per posting. But it will not
visibly move Sudden, and anyone judging the idea on Sudden's numbers is judging it
on a book that has almost no job boards to read. It is aimed at the tech market,
where ATS adoption is close to universal, and that market is not this one.

## How you know it worked

- `hiring_post` signals producing dated facts: 0 today, should be near 1:1 after step 1
- accounts made draftable by a hiring anchor that news never mentioned — this is the
  whole point, and it is the number that justifies steps 2 and 3
- share of the book with a resolved ATS slug, after step 3
- once replies exist: reply rate on hiring anchors vs event anchors, kept separate
