# Cost position review — 2026-08-10

Jake's question: are we losing the token-efficiency angle, does it hold at scale, and is the cost
gain material enough that a buyer doesn't just go to HubSpot / Day / Rox / Claude Cowork.

Everything below is measured on Sudden (2,243 accounts, 115k facts) over the last 30 days, using
`scripts/_cost_01_unit_economics.ts` through `_cost_05_scaling.ts`. Read-only, no LLM, no Exa spend.

---

## The short answer

**The read-layer advantage is real (2.1x measured) but it is the wrong thing to sell.** Tokens are
6% of the bill, so even doubling that efficiency moves ~3%. The same underlying fact — 5.2x more
fact rows than current answers — is worth far more as a correctness argument than a cost one.

**The cost position is genuinely strong, for different reasons than we've been claiming.** $29/month
of compute runs a 2,243-account book end to end with nobody touching it, and that number is capped
by config rather than growing with the book.

**The weak number is volume, not price.** 20 drafts in 30 days, and 0.6% of the facts we pay for
ever reach a message. That is where the next order of magnitude is, and it is worth roughly 10x more
than anything token optimization could return.

---

## What it actually costs

| | 30 days | share |
|---|---|---|
| Exa search | $27.49 | **94%** |
| LLM (all stages) | $1.66 | 6% |
| **Total** | **$29.15** | |

Real billed Exa, read from Exa's own team-management API, is $38.22 account-wide over the same
window — that covers every workspace plus ad-hoc script runs, so the $27.49 model for Sudden alone
is in the right place, slightly understating.

LLM breakdown, 3,919 calls:

| stage | calls | avg input | cached |
|---|---|---|---|
| enricher | 1,557 | 5,349 | 75% |
| scoring | 2,259 | 1,966 | 97% |
| drafter | 103 | 7,187 | 81% |

**Prompt caching is already at 82% of all input tokens.** There is no big unclaimed saving there.

---

## The read-layer claim: real, but the token framing undersells it

`reads.ts:5` says the projections are "summaries and counts, not raw row dumps". Measuring this took
three attempts and the first two were both wrong, in opposite directions. Worth recording, because
the same traps will catch anyone who checks our numbers:

- **Attempt 1 — a fake 7.0x.** `select('*')` on signals pulls `embedding`, 19,189 chars of
  serialized pgvector per row. No wrapper would put that in a prompt. And facts key on
  `subject_entity`, not `entity_id`, so the fact side returned nothing and the comparison was
  signal-bodies-only.
- **Attempt 2 — a fake 1.0x.** Fixing those, I handed the naive baseline a hand-shaped dump: current
  facts already resolved, a 50-signal cap, no internal ids. That is not what a general agent gets
  from a CRM API. I had pre-computed the join *for* the competitor.
- **Attempt 3 — the honest one.** Task-level: tokens to answer "should I write to this account, and
  on what anchor".

```
MEASURED   one call each, same 20-signal window, only fact versions differ    2.1x
MODELED    plus 5 round trips with context carried forward                    3.8x
```

Keep the 2.1x and drop the 3.8x from anything customer-facing. The round-trip half is an assumption
about how the other system is built, and a competitor who writes one `get_account` tool erases it.

**The real finding is not about tokens.** Across those 15 accounts: **2,066 fact rows exist, 395 are
current — 5.2x more rows than answers.** Facts are event-sourced, so a rescore writes a NEW row
carrying `supersedes=<old id>` and the current fact is the one no other row points at. An agent that
filters the obvious way, `supersedes is null`, gets the **oldest** value. Silently. That bug shipped
three separate times inside this repo, written by people who own the schema.

So the argument against a general agent on a CRM API is not "we use half the tokens". It is **"it
reads stale values and cannot tell"** — a two-month-old trigger or a superseded ICP score looks like
perfectly good data. That is a correctness argument, it is worth more than a cost argument to a
buyer, and it is the one thing a competitor cannot neutralise by switching to a cheaper model.

**None of which changes the cost picture.** The read layer lives inside the LLM's 6% of spend, so
even 2.1x there is ~3% of the bill. The system is cheap because of a $0.14/1M model, an 82% cache
hit rate and a capped search budget — none of them a moat.

---

## Scale: cost is capped, coverage is what degrades

`searches_per_run` (30) × 6 ticks/day is a hard ceiling on the only line item that matters:

```
ceiling   5,400 searches / 30d = $37.80
actual    3,937 searches       = $27.56   (73% of ceiling)
```

**That ceiling is the same at 2,000 accounts and at 20,000.** Doubling the book does not raise the
bill. Cost scales fine — the question was wrong.

What degrades is how often any given account gets looked at:

```
book                    2,243 accounts
with a domain           1,163  (52% — the rest are not researchable at all)
researched in 30d         391  (33.6% of researchable)
implied gap between visits   89 days
```

The drafter leads with news only inside `trigger_fresh_days` = 14. At an 89-day gap, most accounts
are outside the news window when their turn comes. Projected at the same budget:

| researchable | gap between visits | share draftable on fresh news |
|---|---|---|
| 500 | 38 days | 36.5% |
| 1,163 (today) | 89 days | 15.7% |
| 5,000 | 384 days | 3.6% |
| 10,000 | 767 days | 1.8% |
| 25,000 | 1,918 days | 0.7% |

**So the honest scaling statement is: the bill is flat and the quality per account falls linearly.**
A bigger book at the same budget is a worse product, not a more expensive one.

---

## What the money buys

```
3,937 searches      $0.01 each
2,272 pages kept
2,482 facts extracted
   20 drafts written              $1.46 each
   14 research facts cited        0.6% of facts we paid for
```

**Cost per research fact that a message actually used: $2.08.**

That is the number to attack. We are buying 2,482 facts a month and using 14.

---

## Against the alternatives

| | price | what the buyer still does |
|---|---|---|
| HubSpot Sales Hub Pro | $90/seat/mo annual, +$1,500 onboarding | all of the work |
| Day.ai | $30+/user/mo | capture is automated, outbound is not |
| Rox | $50 per 5,000 agent actions | enterprise deployment, usage-priced |
| **agent-crm COGS** | **$29/mo for the whole book** | **nothing** |

Rox is the closest model to ours, and it is the one to watch: $50 per 5,000 actions. Our monthly
volume (≈1,000 research runs, 2,482 facts, 20 drafts) sits inside one $50 bucket. So our COGS is
roughly 58% of Rox's list price for comparable volume. **At Rox-style pricing our gross margin is
~42%, which is poor for software.** At $99/month it is ~70%.

The pitch that survives contact with these numbers is not about tokens:

> One seat of HubSpot is $90/month and a person still has to do the work. $29/month of compute runs
> the entire book here, end to end, and stops to ask you only when it wants to send something.

The comparison for a solo founder is not "cheaper CRM", it is "the cost of not hiring an SDR". A
human SDR is $4-6k/month for a few hundred researched, personalised touches. At 20 drafts/month we
are not yet close enough to that volume for the comparison to land, which is the real problem.

---

## Plan, ranked by what it returns

**1. Raise fact-to-draft conversion. Worth ~10x; everything else is noise next to it.**
0.6% of purchased facts get cited. Cost per used fact is $2.08. Getting to 6% takes it to $0.21.
This is the same money buying ten times the output, and it needs no extra spend. Start by finding
out why: the research scorecard's `used` column reads 0 for every question while the funnel finds 14
citations, so the two disagree and neither is currently trustworthy. Resolve that first — it is a
measurement bug or an attribution gap, and we cannot tune what we cannot count.

**2. Concentrate the fixed budget instead of spreading it.**
`research.selection_mix` is unset (default 55/30/15 high_value/active_comms/exploration). With a
capped budget and a 89-day gap, spreading is the enemy. Shifting toward high_value costs nothing and
raises the share of spend landing on accounts that could actually be drafted. Free.

**3. Do NOT raise `searches_per_run` yet.**
We are at 73% of the ceiling; going to 100% costs about +$10/month for +37% searches. That is cheap
and tempting, and it is the wrong order — at a 0.6% citation rate it buys 37% more unused facts.
Fix conversion first, then spend into it.

**4. Fix the domain gap, but only alongside (2).**
48% of the book has no domain and is invisible to research. Backfilling doubles the eligible pool,
which at a fixed budget makes the visit gap *worse* unless targeting improves at the same time.
Sequence matters.

**5. Reposition the read layer from cost to correctness.**
"Token-efficient projections" is a true but weak claim (2.1x, on 6% of the bill). The strong version
of the same fact is that a generic agent over these tables reads superseded values without knowing
it — 5.2x more fact rows than answers, and the obvious filter returns the oldest. Lead with that.
It is checkable in ten minutes by a technical buyer, which is exactly why it is worth leading with.

**6. Deprioritize token optimization entirely.**
6% of the bill, 82% already cached. Even a perfect result returns under $2/month per workspace.

---

## Loose ends found on the way

- **The real-Exa-cost path is dead.** `report.ts:300` resolves `EXA_SERVICE_API_KEY`; the env has
  `EXA_SERVICE_KEY`. The name never matches, so the daily digest silently reports the modeled
  estimate and has never once shown a real billed number. One-line fix, but it means every cost
  figure in the product to date has been a model.
- **`per_angle_fetched` is on too few markers to use as a denominator.** Most runs predate it, so
  "pages fetched" is badly understated and any ratio built on it (I got 243% keep rate) is garbage.
- The scripts are `_cost_01` … `_cost_05`, all read-only, safe to re-run.
