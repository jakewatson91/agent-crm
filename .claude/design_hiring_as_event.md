# Design: a job posting is a dated event, not a document to mine

Status: measured, designed, not built. 2026-08-20.

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

**3. Coverage is the real work.** Only 16 accounts produced hiring posts in 60 days
because the ATS source watches a fixed slug list. To cover a book you need each
account's ATS slug, which is discoverable from its careers page (a Greenhouse or
Lever URL). This is the same shape as the existing `domain_backfill_per_day`
resolver: a daily batch that resolves N accounts' ATS slug and caches it on
`entities.attributes`. Cheap, because it is one fetch per account, once.

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

## How you know it worked

- `hiring_post` signals producing dated facts: 0 today, should be near 1:1 after step 1
- accounts made draftable by a hiring anchor that news never mentioned — this is the
  whole point, and it is the number that justifies steps 2 and 3
- share of the book with a resolved ATS slug, after step 3
- once replies exist: reply rate on hiring anchors vs event anchors, kept separate
