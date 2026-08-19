# Pitch review — 2026-08-16

Jake's question: does the pitch hold up against what people can actually buy, where do we win, where
do we lose, and is there a gap worth chasing.

Every internal number below was measured today on Sudden (2,243 accounts, 117,858 facts) over the
last 30 days. Every competitor price was read off the vendor's own pricing page unless marked
otherwise. Commands to reproduce are at the bottom.

---

## The short answer

**Sell the price of looking at a company. Everyone meters it at ten to fourteen cents; it costs a
penny.**

Attio's web research agent is 10 workspace credits per record, which at their own top-up rate works
out to **$0.14 per company researched**. HubSpot charges **$0.10 per company research task**. Our
all-in cost is **$0.046 per research pass**, of which $0.039 is the web search itself. Scaled to a
real book, watching 2,243 companies once a month runs **$254 to $279 on Attio Pro** against **$49
here**. That is 5 to 6x, it comes off published price lists, and a prospect can verify it in five
minutes.

Be honest internally about what that gap is: **it is a markup gap, not an efficiency gap.** Web
search is cheap and we buy it wholesale. Credit stores mark it up. Do not dress this up as
architecture.

The second leg is that the model writes better email off our data than off a CRM record: 4.2 to 4.4
on relevance against 2.7 to 3.1 for the same model reading HubSpot records, holding across three
independent judge runs.

The leg that does not exist yet is output. 23 drafts a month with no sending machinery is not a sales
motion, and our setup asks a founder to run database migrations. Those two things, not the pitch, are
what blocks a close.

### Two claims I had to walk back

**"We throw away 83% before it costs a model call" is not a cost story.** The 83% gets dropped
*after* the search is paid for, so it saves the extraction call, which lives inside the 14% of the
bill that is LLM. Web search is 86%. Restraint saves real money on the small line item and does not
explain why we are $49 and Warmly is $700.

**Selection is not saving much money either.** 4,142 searches over 1,065 passes is 3.9 searches per
pass. Researching every researchable account once a month would be about 1,301 passes, roughly $51.
We spent $29-41 doing 534 accounts about twice each. Selection concentrates passes on better
accounts. It does not cut the bill.

---

## What it costs us to run a real book

Sudden, 30 days, measured:

| | 30 days |
|---|---|
| Companies in the book | 2,243 |
| Companies actually researched | 534 |
| Research passes | 1,065 |
| Web searches | 4,142 |
| Raw results fetched | 11,405 |
| Results kept after filtering | 1,976 (17%) |
| Model extraction runs | 1,648 |
| Scoring runs | 2,542 |
| Live facts on the book | 4,108 |
| Drafts written | 23 |

Cost, stated as a band because the two internal price tables disagree and I am not going to pretend
they don't:

| | low | high |
|---|---|---|
| LLM (all stages) | $4.83 | $7.66 |
| Web search (4,142 at $0.007 / $0.010) | $29.00 | $41.42 |
| **Total** | **$33.83** | **$49.08** |

Real billed web search across the whole account for the same window was **$40.82**, which sits inside
the band and slightly above the Sudden-only model, as expected since it covers every workspace and
every ad-hoc script run.

**Use $49/month in every comparison.** It is our worst case, it is still the lowest number on the
board, and quoting the pessimistic figure is what makes the rest of the deck believable.

Derived units:

- **$0.022 per company per month**, for a company that is being watched, scored and kept current
- **$0.046 per research pass**, all in, including scoring and storage
- **$0.092 per company actually researched in the month**
- **$1.47 per draft written.** Do not put this next to HubSpot's $1.00 outcome price. Ours is total
  monthly spend divided by drafts, so it carries the cost of watching 2,243 companies that produced
  nothing; theirs is a marginal price with a $90 seat and $1,500 onboarding sitting outside it.
  Different denominators, not a comparison.

---

## What a founder can buy instead

All verified on the vendor's pricing page today unless marked.

| | entry price | what that buys |
|---|---|---|
| **agent-crm (self-host)** | **~$49/mo compute** | 2,243 companies watched, 1,065 research passes, 23 drafts |
| Twenty | $9/user/mo, or free self-hosted | good data reads, no research agent |
| Day.ai | $24/mo Turbo, $60 Pro, $200 Executive (per agent) | captures your email and calls; does not do outbound |
| Attio | Free / $35 Plus / $79 Pro per seat, annual | Plus = 150 research runs/mo; Pro = 1,000 |
| Rox | $100/mo Individual, 10,000 agent actions | closest model to ours; usage-metered |
| HubSpot Sales Hub Pro | $90/seat/mo annual + **$1,500 one-time onboarding** | 3,000 credits; agent bills on top |
| Clay | $149 Launch / $446 Growth monthly | 3,000 data credits on Launch; you drive the tables |
| Common Room | $625/mo | signal monitoring for funded teams |
| Warmly | $700/mo | monitoring plus autonomous outbound |
| Unify | $20/seat Base, $60/seat Pro | 800 / 2,400 credits per seat |
| Regie.ai | $180/seat with a **10-seat minimum** = $1,800/mo | full sales engagement product |
| 11x | ~$5,000/mo, $50-60K first-year minimum (secondary) | full AI SDR, annual lock |
| A human SDR | $90-154K/yr fully loaded (secondary) | 3.2 months to first qualified meeting |

Two per-unit prices that matter more than the plan prices:

- **HubSpot bills $1.00 (100 credits) every time the Breeze prospecting agent recommends one lead
  for outreach.** That is from HubSpot's own announcement, effective 2026-04-14. Company research is
  reported at $0.10 per task (secondary source, HubSpot's own docs decline to state it). **We have
  never measured what that $1.00 buys.** Breeze's output quality is unknown to us. The quality
  benchmark in this repo measures a DeepSeek model reading HubSpot's *API records*, which is a
  different product from HubSpot's own agent. Do not imply otherwise in a pitch.
- **Attio's web research agent costs 10 workspace credits per record.** At their top-up rate
  ($70/mo for 5,000 credits, annual) that is **$0.14 per record researched**. Ours is $0.046 per
  research pass all in. Attio's cheapest paid plan, Plus at $35/seat, includes 1,500 workspace
  credits, so **a founder on Attio Plus gets 150 research runs a month. We ran 1,065.**

---

## Where we win, with the receipt

**1. Price of looking at one company. This is the strongest claim and the easiest to check.**
Attio's research agent is $0.14 per company at their top-up rate. HubSpot's is $0.10 per research
task. Ours is $0.046 per pass, of which $0.039 is the web search. Scaled to a 2,243-company book
researched once a month, Attio Pro runs $254 to $279 (22,430 credits against a 10,000 allowance,
plus the $79 seat) against our $49 for 1,065 passes. Attio Plus at $35/seat caps a founder at 150
research runs a month.

Say the reason plainly rather than implying cleverness: **a web search costs about a penny and credit
stores mark it up ten to fourteen times.** Our bill is also set by a config number, so it does not
move when the book grows.

**2. The agent reads once instead of four times.** 696 committed runs, five real platforms, same
model on every side, reproducible with `pnpm benchmark:v1:audit` and no API keys:

| platform | $/action | vs us | LLM calls per action |
|---|---|---|---|
| **agent-crm** | **$0.000994** | 1.00x | **1.00** |
| Twenty | $0.001030 | 1.04x | 2.11 |
| HubSpot | $0.002243 | 2.26x | 3.44 |
| Day.ai | $0.004308 | 4.33x | 4.95 |
| Attio | $0.004702 | 4.73x | 3.22 |

Honest caveat that has to stay in: **Twenty ties us.** Their GraphQL read bundles data the same way
ours does. This is an argument against HubSpot, Day.ai and Attio, not an argument for us over Twenty.

**3. The emails are more on-target, and this one is stable.** A blind judge, one rubric, all five
platforms scored against the same seeded truth. I ran it three times because the committed writeup
looked too good, and here is every run:

| | agent-crm | Twenty | HubSpot | Attio |
|---|---|---|---|---|
| relevance | 4.39 / 4.29 / 4.22 | 3.22 / 3.33 / 3.18 | 3.11 / 2.72 / 2.94 | 3.33 / 3.39 / 3.31 |
| specificity | 3.56 / 3.35 / 3.39 | 2.89 / 2.94 / 2.65 | 2.94 / 2.61 / 2.76 | 3.22 / 3.06 / 3.25 |

Same drafts, same judge, three independent passes, and the gap holds every time. Drafts written off
our data land around **4.2 to 4.4 on relevance against 2.7 to 3.1 for the same model reading
HubSpot's records.** That is roughly 40% better and it did not wobble.

**4. Fewer invented claims than HubSpot and Attio.** Unsupported claims per draft across the same
three runs:

| | run 1 | run 2 | run 3 |
|---|---|---|---|
| agent-crm | 0.28 | 0.65 | 0.72 |
| Twenty | 0.33 | 0.56 | 0.65 |
| HubSpot | 0.94 | 1.00 | 0.94 |
| Attio | 0.83 | 1.33 | 1.56 |

We beat HubSpot and Attio in all three. The mechanism is visible in the flagged claims: hand a model
a whole record and it cannot tell a real company fact from an internal field, so HubSpot wrote a
suppression flag into an email and Attio invented a funding round. Our drafts pull from separate
labeled facts, each tied to the page it came from.

**5. We throw work away before paying to think about it. Real, but keep it out of the cost pitch.**
Measured today:

- 11,405 raw results fetched, **9,429 (83%) dropped** before an extraction model ran: 7,508 off-target,
  1,584 too old, 336 near-duplicates
- 2,401 extraction runs skipped by burst-coalescing and cooldowns; we ran 1,648, which is **41% of
  what a naive one-run-per-signal loop would have spent**
- End to end, **one model run per 6.9 raw results fetched**

The filtering happens *after* the search is paid for, so what it saves is the extraction call, and
LLM is 14% of the bill against web search at 86%. This is a quality argument (the model only reads
things that are on-target, current and not duplicates, which is why the drafts score the way they do
in #3) and not a cost argument. Selling it as a cost argument is what the first draft of this review
got wrong.

---

## Where we lose

**1. Volume. This is the one that kills deals.** 23 drafts in 30 days from a 2,243-company book. 28
approvals sitting undecided right now. The most recent advance run scanned 400 accounts and created
zero drafts. Everything in the win column is priced per company watched; every competitor quotes per
thing produced. We are winning the metric the buyer is not asking about, and we have no answer at all
to a product that quotes meetings booked.

**2. No sending machinery.** Email goes out through Resend when you approve, and the LinkedIn channel
is manual copy-paste. There is no mailbox warming, no domain rotation, no bounce or complaint
monitoring. Google, Yahoo and Microsoft now enforce bulk-sender rules at under 0.3% complaints and
under 2% bounces. Every AI SDR product ships this and sells on it, because cold email in 2026 is
decided by sending reputation before anyone reads the copy. This is the biggest hole for the buyer
we say we are targeting.

**3. We stop at the draft.** No reply handling, no meeting booking, no follow-up sequence. Monaco
launched in February 2026 with $35M and sells autonomous meeting booking to seed-stage startups. A
founder comparing us to that is comparing "23 drafts to review" against "meetings on your calendar."

**4. Nothing comes in from the founder's inbox.** Day.ai and Coffee both auto-capture from Gmail and
Calendar with zero human effort, which is the entire reason a busy founder tolerates a CRM. Our
Composio connections are read-only and outbound from the user's own Gmail is not built.

**5. Setup is a wall.** Create a Supabase project, apply 54 migrations, fill in env vars, run docker
compose. The buyer we describe has five minutes a day. This breaks our own setup-first rule in
CODING.md, and no amount of pitch fixes it.

**6. Quality per company falls as the book grows.** At 1,301 researchable accounts the gap between
visits is 74 days. At 5,000 it is 282 days, and the share of the book with news fresh enough to lead
with drops from 19% to 5%. The bill stays flat and the product gets worse. Do not let a prospect
with a 10,000-company list discover this in month two.

**7. Twenty neutralizes the token story.** They tie on cost per action, they are as clean as us on
invented claims, they are $9/seat with a hosted option, and they are open source. Anything that
leads with token efficiency argues them into the deal, not out of it.

**8. Our own quality writeup cherry-picks.** `benchmark/v1/QUALITY.md` publishes 0.28 unsupported
claims and 78% clean drafts. Re-running the identical eval on the identical drafts gave 0.65/53% and
0.72/44%. The committed number is the best of three draws. **Do not put 0.28 in a deck.** Fix the doc
to publish the range and lead with relevance, which is the number that actually held.

---

## The pitch

Stop opening with anything about how data is stored. Open here.

> You have two thousand companies you could sell to. You have five minutes a day. Every one of those
> companies is doing something right now that would make a good reason to write to them, and by the
> time you find out, the reason is gone.
>
> Fifty dollars a month of compute reads all of them, every day, and hands you the two or three where
> something actually changed. The email is already written. The page it came from is linked, with the
> date on it. You say yes or no.
>
> Every tool that will do this for you meters how many companies you are allowed to look at. Attio's
> cheapest paid plan gives you 150 company research runs a month. HubSpot charges ten cents a
> research task and a dollar every time it recommends someone. Watching a two-thousand-company list
> that way runs about two hundred and fifty a month before the seat fee.
>
> A web search costs about a penny. We charge you for the searches and stop metering how much you
> are allowed to know.

Order of proof when they push back:

1. **Money, per company looked at.** $0.046 here against Attio's $0.14 and HubSpot's $0.10. Scaled to
   a 2,243-company book that is $49 against $254 to $279 on Attio Pro. Say why: search is a penny and
   credit stores mark it up. Do not claim an efficiency edge that is really a margin edge.
2. **Time.** Five minutes a day, and approving is the only thing you do.
3. **Trust.** Blind-judged against ground truth, drafts off our data score 4.2 to 4.4 on relevance
   against 2.7 to 3.1 for the same model reading HubSpot records, and carry fewer unsupported claims
   than HubSpot or Attio in every run.
4. **The real alternative.** An SDR is $90-154K a year fully loaded and takes 3.2 months to book a
   first qualified meeting.

What NOT to say: that we are cheap because we are disciplined. The filtering is a quality mechanism,
and web search is 86% of the bill. If a technical buyer checks, the discipline claim does not survive
and it takes the rest of the deck with it.

Answer to "why not just point Claude at my CRM": the same model doing the same job through HubSpot's
API costs 2.26x more per action and makes 3.44 calls where we make one, and it writes internal
fields into outbound email because it cannot tell them apart from real company facts.

Answer to "why not Twenty": don't fight it on cost, you lose. Twenty stores your data well and has
no research agent. Nothing in it watches the web for you or decides what is worth reading.

---

## Words to cut from every deck, page and email

These are true and they do not sell. They are also the exact words that make a founder's eyes
glaze: provenance, replay, event-sourced, content-addressed, cite chains, projections,
token-efficient reads. Keep the mechanism in the engineering docs. In a pitch, the only sentence that
earns its place is "the email links the page it came from, with the date on it."

Also retire the 4.22x drafter number, already archived in `v0_ARCHIVE.md`, and the
5.0x/5.8x figures still sitting in `BENCHMARK.md`. Today's audit run produces 2.26x/4.33x/4.73x
because DeepSeek's prices moved. **`BENCHMARK.md` currently disagrees with its own audit script.**

---

## Gaps in the market worth chasing

**1. Nobody sells "watch my list and stay quiet" at founder prices.** The monitoring category
(Common Room $625, Warmly $700, and Koala, which shut down) is built and priced for funded sales
teams. The AI SDR category starts at $1,800 and runs to $5,000. The CRM category meters research so
tightly that continuous watching is unaffordable on entry plans: 150 runs a month on Attio Plus, a
dollar a recommendation on HubSpot. The space under $100/month for a founder who wants their whole
list watched is empty, and our cost structure is already sitting in it. This is the one to take.

**2. Sending is our biggest hole and it is a commodity.** We should not build mailbox warming and
domain rotation. Instantly and Smartlead already sell it. Plugging into one converts loss #2 into a
config field and lets us keep selling judgment rather than send volume.

**3. Fact-to-draft conversion is worth more than everything else on this list.** 0.7% of the research
facts we pay for ever get cited in a message. Cost per used fact is around $2. Getting that to 6%
turns 23 drafts into roughly 150 on the same spend and closes the volume loss without raising the
bill by a cent. This is already the top item in `cost_position_review.md` and it is still the top
item.

**4. Setup as a product, not a README.** Hosted signup with a paste-your-key screen. Until a founder
can get a book watched without touching a migration, every number in this document is theoretical to
them.

---

## Reproduce

```
pnpm exec tsx scripts/_cost_01_unit_economics.ts
pnpm exec tsx scripts/_cost_03_funnel.ts
pnpm exec tsx scripts/_cost_05_scaling.ts
DOTENV_CONFIG_PATH=.env.local pnpm exec tsx scripts/_cost_02_exa_actual.ts --days 30
DOTENV_CONFIG_PATH=.env.local WS=e7052848-2270-41ac-90b6-d9b75c87f6d3 DAYS=30 pnpm exec tsx benchmark/v1/system_yield_audit.ts
DOTENV_CONFIG_PATH=.env.local WS=e7052848-2270-41ac-90b6-d9b75c87f6d3 DAYS=30 pnpm exec tsx benchmark/v1/enrichment_cost_audit.ts
pnpm benchmark:v1:audit
pnpm benchmark:v1:quality
```

Competitor prices read 2026-08-16 from attio.com/pricing, hubspot.com/pricing/sales,
clay.com/pricing, day.ai/pricing, twenty.com/pricing, rox.com/pricing, unifygtm.com/pricing,
regie.ai/pricing, and hubspot.com/company-news (outcome pricing announcement). 11x, Artisan, Apollo,
Common Room, Warmly, SDR salary and reply-rate figures are secondary and marked as such in the text.
