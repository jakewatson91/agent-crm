# Outreach v1: what the bad draft actually proved, and the design that follows

> **Read `v1_plan.md` first.** This file is the drafting mechanics: why the Wedotv first line
> was garbage, what the anchor is, and what it lets us delete from the prompt. `v1_plan.md`
> is the wider call written 2026-08-18: what v1 is, what gets cut, the two numbers a founder
> sets, the sequence, and the setup flow. Nothing here is contradicted by it.

Status: thinking + evidence, nothing built. Started 2026-08-18.
Resume point is at the bottom under "Where I stopped".

---

## Correction, 2026-08-18: the recipient story is over, and this doc said the wrong thing twice

An earlier version of this doc led with "0.7% of drafts cite a fact" as the single
biggest lever. That was replaced with "74 of 91 refusals are about the person, not the
facts, so write a fourth template and fill in `personas.target_roles`." Both are wrong,
and the second one is wrong in a way worth writing down.

The rule that produced those refusals is in code, at `prompt_builders.ts:435`:

> "Match the recipient's real role to the AUDIENCE lines and pick exactly one. If the
> recipient matches none of them, do not force a fit: output request_gate."

It only renders when at least one template is switched on (`prompt_builders.ts:338`
filters to `enabled !== false`). **All four of Sudden's templates were switched off on
2026-08-14.** So the rule has not been in the prompt for four days, and the refusal
class it created cannot happen any more.

Measured, `scripts/_tmp_refusal_shape.ts`: 56 refusals on Sudden since 9 July, about 40
of them naming a missing job title. The last one is 14 August 14:34. Every refusal since
is about facts, and every one is the same account. The mechanism is certain (the sentence
is not in the prompt); the live confirmation is only five refusals on one account, so it
is the code that proves it, not the counts.

**So: no fourth template. No `target_roles` list. No change to what the contact budget
buys.** Sudden is not sending to anyone, the contact pull is a free-tier test of whether
contacts help enrichment at all, and Hunter is out of credits for the month regardless.
Contacts are not a blocker in this doc any more, and where they appear below as one, that
line is struck.

---

## The short version

The Wedotv draft was approved on evidence the drafter then refused to use.

Wedotv cleared the outreach bar because the scorer gave it `signal_strength` 0.70,
and it gave it 0.70 for the seven FAST-channel launches sitting in its facts. The
drafter then ruled all seven out of scope, correctly, because Sudden cannot serve
the live side. What was left was the company description, so that is what it opened
on. Its own recorded reasoning says exactly this:

> "Theme-led. Anchored to Wedotv's free, ad-supported streaming model and scale...
> The recent launch facts are linear/FAST channel distribution on the live side, so
> I did not anchor on them."

So the first line is not a writing failure. By the time the model started writing
there was nothing left to open on, and there is no path in the system that can say
"then don't write." Every path ends in either a draft or a refusal that has to name
a missing fact, and "everything I know is off limits" is not a missing fact.

The fix is one change, and it removes far more than it adds: **choose the anchor
before deciding to write, not after.**

---

## What the anchor is

One fact. It has to be all five of these:

1. something that happened, not something they are
2. dated, and inside the freshness window
3. not ruled out by what we are allowed to write about
4. not already used in an earlier message to this account
5. it reaches one of the problems we solve in a single step

No anchor, no message. The anchor is both the reason we acted and the first line of
the message, so the two can never come apart again.

Points 1, 2 and 4 are pure code. Point 1 and 2 need one new field on facts (below).
Point 4 is a read of `channel_posts.cites` we already do for the over-use penalty.
Point 5 is `pickDraftAngle`, which already runs and already demands a citation, just
given the anchor as its starting point instead of the whole fact list.

Point 3 changes shape, and this is the second real simplification. Today the ruling
happens as a sort: hand a model forty facts and ask which ones are off limits. That is
a hard task, it was over-flagging badly enough to need a quote check bolted on as a
guard, and the guard is why it now under-flags. Instead: rank the candidates by
recency, then ask one yes-or-no question about the top one. "Here is one event. Here is
what we are never allowed to write about. Can this be the subject of a message?" If no,
ask about the next one down. A single-item question can afford to be strict, because a
false no costs the next candidate rather than the whole account, and that is exactly
what the sort could not afford.

---

## What this deletes

This is the part that matters. Every one of these exists to compensate for the
missing anchor, and every one goes away.

**The whole trigger-mode section of the drafter prompt.** About 1,400 words: trigger-led
mode versus theme-led mode, published dates versus recorded dates, "age kills events
not state", "a theme needs convergence", "pick the strongest not the first", and the
three checks in the final checklist that verify the model classified itself correctly.
All of it is the model guessing at a question the data answers. Hand it one anchor and
one date and the section becomes two lines.

**The recommended-facts shortlist as the source of the opening line.** It ranks by
similarity between the fact and the ICP text. A company description is the densest
possible match to a description of who we sell to, so descriptions outrank launches
by construction. That is not a tuning problem, it is what cosine similarity does. The
shortlist is good at picking what to *cite*; it should never have been picking what
to *open on*.

**`pickTriggerFactId`'s hook list** in `advance_accounts.ts`. It prefers four fact
labels: `buying_signal`, `recent_event`, `pain_observed`, `hiring_role`. Sudden's book
produces `recent_launch` (83 across draftable accounts), `news_event`, `product_launch`,
`content_partnership`, `partnership`, `streaming_lineup_expansion`. Three of the four
names in code never appear. So the fall-through fires almost every time and the
"trigger" handed to the drafter is whatever fact sorts first, which for Wedotv is
`country = Switzerland`. It is also a hardcoded list of label names in shared code,
which is the thing we are not supposed to do.

**`signal_strength` as an outreach condition.** See the next section.

**`ask_examples` and the ranked menu of four endings.** See "The ask".

**`tone_keywords`.** Adjectives do not produce voice. Pasted examples do.

---

## Why signal_strength has to stop being the outreach condition

The rubric asks: "how *actionable* is the most recent signal, FOR WHAT WE SELL". That
is a fit question in a timing costume. Nothing anywhere in the score asks whether
something happened.

Measured on Sudden's live book today:

| | accounts |
|---|---|
| have a dated event in the last 30 days | 79 |
| of those, blocked by `signal_strength` < 0.7 | 49 |
| of those, blocked by no reachable contact | 59 |
| of those, blocked by `score_total` < 0.65 | 3 |
| of those, blocked by `evidence_depth` < 0.5 | 0 |
| clear everything today | 7 |

Six of the 79 are blocked by `signal_strength` alone and nothing else. They include a
Stingray Group agreement signed with Titan OS to launch nine channels across Europe,
and a BT Sports multi-year deal with Frank Warren for 20 boxing shows a year. Both
scored 0.4, "passive presence". Meanwhile Wedotv scored 0.70 on launches it was
forbidden from mentioning.

Replace the guess with the thing. An anchor is a fact id with a date and a source URL.
It is deterministic, it shows on the approval card, and it cannot disagree with the
message the way a score can.

Do not touch the scoring weights. `signal_strength` stays a dimension of `icp_total`
at its current 0.10 so no rescore is triggered. It just stops being one of the three
conditions in `selectAction`.

---

## The same failure is in three of the five drafts waiting for approval

Sudden's own rule says a live match, tournament, rights deal, live launch or live
audience number is never what a message is about. Reading the pending approvals:

- **NHL.TV**, 14 Aug: opens on the NHL.TV launch on DAZN across nearly 200 countries.
  A live rights deal.
- **M6+**, 14 Aug: opens on 4.2 million accounts added during the World Cup. A live
  audience number.
- **ViX**, 14 Aug: opens on a record 30 million viewers for the World Cup. A live
  audience number.

These read well, which is why they did not stand out. They are built on subjects the
workspace said never to build on. The drafter-quality file already records this pattern
from 13 August ("three of four drafts did it anyway"), and the sort in `pick_angle.ts`
was written for it, so this is confirmation rather than a new discovery. What it shows
is that the sort as built does not close it, and the reason is the quote check: it
requires the ruled-out words to appear in the fact's own text, and "World Cup" does not
contain the word "live". Loosening the quote check is not the answer, since it was added
because the sort was deleting good prospects on nothing but a company's reputation.

The one-question-per-candidate version above dissolves the tension. The quote check
exists to stop a sort from over-reaching across a long list. Ask about one fact and the
guard is not needed, so the strictness can go back in.

---

## Facts have to carry when the thing happened

Add `happened_at` (nullable timestamp) to facts. The enricher writes it at extraction,
null for anything that is not an event. The enricher is the only thing that ever reads
the page, so it is the only thing that can know.

Right now three separate places re-derive a fact's time meaning, each with its own
guesswork:

- `score_facts.ts` recency: aged from the source publication date, flat 1.0 if there is
  none, which is why every one of Wedotv's undated facts tied and similarity broke the tie
- the drafter's mode section: about 500 words teaching the model to tell "published on"
  from "we recorded it on"
- research freshness

One nullable column replaces all three, and it permanently closes the "unknown date
defaults to today" class of bug that has now been fixed in three places separately.

Coverage today: 565 of 737 event-shaped facts (77%) have a usable source date, so the
information mostly exists and is just not attached to the right row. Backfill by running
the classification once over facts on accounts above the fit floor with a source date in
the last 90 days. That is a few hundred cheap calls, once. Do not backfill by copying
the source date onto every fact: a company profile page has a publication date and the
description on it is still not an event, and that mistake is precisely the Wedotv failure.

---

## Splitting out-of-scope in two

Sudden's first out-of-scope condition is currently a paragraph doing two unrelated jobs,
because there is nowhere else to put the second one:

> "...This condition rules an ACCOUNT out only when its video is live only. Live is out
> of scope entirely for what we write about, though: ...a live match, tournament, rights
> deal, live launch or live audience number is never the thing a message is about,
> however fresh it is. Anchor on the catalog or do not write."

Two settings, not one:

- **who we cannot sell to**, which vetoes the account in the scorer
- **what we cannot write about**, which vetoes a fact as an anchor

Wedotv is the case that needs both to exist separately. It is sellable, because it has
a catalog we can serve. Every event we know about it is unwritable. Under the split that
state is expressible, and the honest outcome is "no anchor, no message, go research their
catalog", which is what should have happened on 15 August.

Both start empty. Both are plain sentences a customer writes about their own product.

---

## The ask

The question was: sometimes a plain question is the right ending, sometimes a real ask,
sometimes another sentence about us, sometimes nothing.

There is no rule for it because it is not a property of the message. It is a property of
where you are in the conversation.

- **Touch 1.** They have never heard of you. The only thing you can ask for is a reply,
  so end on the question and offer nothing. An offer is meaningless before you have said
  what you do, and at 300 characters there is no room for both, which is exactly what the
  current prompt spends a paragraph explaining.
- **Touch 2, no reply.** Now one sentence about what you do has been earned. Offer the
  specific thing you would produce for them.
- **Touch 3.** The easy out. A question they can close with one word gets answered.
- **Then stop.**

So the ending comes from the step number, chosen in code, rendered as one line. The
ranked menu of four endings and its five paragraphs of guidance come out, and so does
`ask_examples`.

This is also why the ending was the line that came out identical across every message:
it was the last thing written, it was chosen by the model from a fixed list, and it was
the only part with no account-specific input at all.

---

## The sequence

Three fields per step. That is the entire sequence editor.

```
outreach.sequence: [
  { after_days: 0, purpose: "open",  max_chars: 300 },
  { after_days: 4, purpose: "offer", max_chars: 400 },
  { after_days: 7, purpose: "close", max_chars: 300 },
]
```

`purpose` is one of three values, because each one maps to a fixed rule about the ending.
Free text would put the decision back inside the model, which is the thing being removed.
Step count is free: open, offer, offer, close is a legal four-step sequence. A one-step
sequence is one row.

Two rules that stay in code, not config:

- **Only touch 1 needs an anchor.** A follow-up four days later is not opening cold, it is
  continuing a thread, so requiring a fresh event would be inventing one. This is where the
  market-brief work already built and sitting dormant belongs, and the note on it from
  1 June says the same thing: its real home is follow-ups, not first touch.
- **A reply ends the sequence** and hands the account to the human.

Sudden's actual process maps onto this exactly and is currently invisible to the system:
connection request with a note at 300 characters, DM after the accept at 400, then a bump.
That is three rows.

**The missing piece.** `replied` is a defined transition in `lifecycle.ts` and nothing in
the codebase ever sets it. `contacted` is set in one place, when an approval is decided.
Until one click can record a reply, a sequence cannot safely advance and step 2 would fire
at people who already answered. This is the one new human surface in the whole design, and
it passes the rule: it is an action on an approval, not a view of a list.

---

## Setup a founder can finish in an afternoon

The drafter config is about twenty fields today. Most of them are ways of describing a
message to a model that cannot see the decision behind it. With the decisions moved out,
this is what is left.

| Setting | Question the founder is answering | Keep? |
|---|---|---|
| about | what do you sell, what does it do | keep |
| icp | who is it for | keep |
| pain_points | what three problems do you fix | keep, central |
| value_props | what are you allowed to claim | keep, central |
| constitution | what may never be said, and in what voice | keep |
| cannot_serve | who can you not help | keep, renamed from out_of_scope |
| cannot_write_about | what subjects are never the message | new, split out of the above |
| outreach_channel | where do you send | keep |
| sequence | how many touches, how far apart | new, three rows, defaults supplied |
| examples | paste one to three messages you have sent and liked | replaces templates |
| outreach_language | which language | keep |
| forbidden_phrases | words you never want to see | keep |
| trigger_fresh_days | how long news stays news in your market | keep |
| ~~templates: id/label/audience/body/angle/anatomy/follow_up/notes/enabled~~ | | collapses into examples + sequence |
| ~~message_rules~~ | | goes into the constitution, same job |
| ~~char_budget~~ | | moves onto the sequence step |
| ~~trigger_max_age_days~~ | | with `happened_at`, one window is enough |
| ~~ask_examples~~ | | the step's purpose decides the ending |
| ~~tone_keywords~~ | | examples carry voice, adjectives do not |
| ~~cr_note~~ | | it is sequence step 1 |
| ~~subject_style, paragraph_count~~ | | email shape, keep but not asked at setup |

Eleven questions, most with defaults. Templates were the heaviest thing to fill in, took
the most explaining, and all four of Sudden's are currently switched off.

---

## The finding that is bigger than the draft

The pass is producing about one draft a day. Last nine runs, in order: 0, 0, 1, 1, 4, 1,
1, 0, 0. It scans 400 accounts each run out of a book of 2,132, while about 27 new
event-shaped facts arrive daily.

79 accounts have a real dated event in the last 30 days. Seven of them can be written to
today. The two blockers are no reachable contact (59) and `signal_strength` (49).

That reframes the pitch. It is not "we write better cold messages", which every tool now
claims. On LinkedIn you get roughly 20 sends a day whatever you do, so writing quality is
table stakes and the only question left is *which 20*. Picking them is what a system that
stores events, facts, dates and sources is actually for. Nobody sells that, because
everybody is selling volume.

It also means the anchor rule does not cost volume. It raises it, because the condition it
replaces is blocking 49 accounts that have a genuine reason to write. Rough arithmetic on
today's book: drop `signal_strength` from the outreach conditions and require an anchor
instead, and the standing pool goes from 7 to near 76, once a missing recipient stops
counting as a reason to withhold a draft, against a supply of about 27 new event facts a
day.

**`signal_strength` cannot simply be deleted, and the size of that mistake is measurable.**
67 accounts clear all three score bars. Take `signal_strength` out and leave the other two,
and 1,782 of 2,133 clear. It is currently doing effectively all of the gating on this book,
so removing it without putting the anchor test in its place turns a pass that writes one
message a day into one that tries to write to five sixths of the book. The anchor is what
bounds it back to the ~79 with something that actually happened.

One caveat on the 79. "Is this fact an event" was measured with a keyword test over fact
labels, standing in for the `happened_at` field that does not exist yet. The direction is
not in doubt and the shape of the funnel is not in doubt. The exact number will move once
the real field exists, and it will move up, because the keyword test cannot see an event
whose label happens not to contain one of the words.

---

## Overlap with the walk-order work in flight

`advance_accounts.ts` has uncommitted changes to `compareWalkOrder` from the score-collapse
session, fixing the pass so it walks the accounts that clear the outreach bar first instead
of sorting by score. That is about *reaching* the right accounts inside a 400-account scan.
This document is about *which accounts should qualify*. They do not collide, and the funnel
numbers here are read straight from facts rather than from a walk, so they hold either way.
Do not re-diagnose the walk order from anything written here.

## What is deliberately not changing

- `pickDraftAngle` stays, and gets a better input
- `score_facts` stays, for choosing what to cite
- the out-of-scope sort with its quote check stays, it is the part that works
- the learning loop from edits stays
- research stays, and gets a new job: "no anchor" routes here instead of to a draft
- scoring weights stay untouched, so no full-book rescore is triggered
- templates are not deleted, they shrink to pasted examples

## The lever held back on purpose

There is an honest message with no anchor: lead with what you see across the category and
ask whether it applies, never opening with a description of the reader back at them. It is
lower reply rate but it is not dishonest, and it is the volume lever a founder can switch
on.

Do not build it in v1. The entire value story is that the machine does not write when it
has nothing to say, and this is the one setting that would erode it. Design it, name it,
leave it off.

---

## Stop requiring a person before the drafter is allowed to try

Read on the live book today, alongside the numbers above:

| | accounts |
|---|---|
| have a current `score_total` | 2,133 |
| clear all three score bars (0.65 / 0.70 / 0.50) | 67 |
| of those 67, zero contacts linked | 35 |
| of those 67, at least one contact linked | 32 |

Half the accounts the drafter is allowed to reach have nobody on file. Those 35 queue for
phase 2, phase 2 tries to buy a contact, Hunter is dry, and they sit there every night.

Two places have to agree before a draft can happen without a recipient:

- `advance_accounts.ts:350` drafts only when `best >= DRAFT_MIN_CONTACT_SCORE`
- `action_selector.ts:179` returns `enrich_contacts` before it can ever reach draft, on
  both "no contact linked" and "contact below the bar"

One knob covers both: `policy.routing.require_contact`, default true, so nothing changes
for a workspace that actually sends. False means a missing recipient stops being a reason
not to write. Zero credits, and it doubles the pool the drafter gets a shot at, which is
the whole point when the question is whether research is producing anything worth writing.

**The hazard, and it needs handling in the same change.** With no contact the LinkedIn
prompt has no name in it, and "0 invented recipients" is one of the graded lines in the
drafter dry run. Told nothing, the model will make a person up. It has to be told it is
writing to the company.

---

## Open questions for Jake

1. **Freshness window.** 14 days leaves 22 accounts standing, 30 days leaves 79. 30 looks
   right for this market but it is a market judgment, not a technical one.
2. ~~**Contacts are the bigger blocker than anything discussed here.**~~ **Answered
   2026-08-18: contacts are not a blocker, they are a free-tier test of whether contacts
   help enrichment.** Sudden sends to nobody, so a recipient we cannot use is not a reason
   to withhold a draft. Do not spend a session on contact quality, do not switch provider
   for this, and do not treat the Hunter wall as an outage. The change that follows is the
   `require_contact` knob above.
3. **Reply recording.** One click on the approval card is the cheap version. Is that enough
   for how Sudden actually works, given sends are manual copy-paste?
4. ~~**Do the four disabled templates come back?**~~ **Answered by the measurement at the
   top: they stay off.** Switching them on switches the job-title refusal back on with
   them. When the "examples" field replaces them it must carry no audience line, or this
   returns wearing a different name.

---

## Zee5 is the live version of the Wedotv failure, five days running

Every refusal on Sudden since 14 August is the same account saying the same thing:

> 16 Aug: "I would need a fact about Zee5's on-demand catalogue viewership or delivery cost
> pressure, separate from its live FIFA World Cup coverage."
> 18 Aug: "...because every fresh fact is live FIFA World Cup coverage, which is out of scope."

Sellable account, and every fresh thing we know about it is a subject the workspace said
never to write about. That is exactly the Wedotv case, and it is also proof the label is
still lying: it files under `facts_insufficient_for_draft` when the honest reason is
"everything I have is out of scope, go research their catalogue." Under the split in
"Splitting out-of-scope in two", this becomes its own outcome and routes to research
instead of repeating a refusal nightly.

## The bad works_at edges are real and small

Measured across all 281 `works_at` edges on Sudden: 214 have both a work email and an
account domain to compare. 16 of those (7%) carry an email on a different domain, and most
are correct — Bitcine is CineSend's old name, Global News runs on Corus addresses, Sinclair
on sbgtv.com, Zeam on Syncbak, Prime Video on amazon.com. The genuinely wrong ones are
Amazon addresses stapled to companies that are not Amazon: Verizon Fios TV, and the SOOP
case that started this. A handful out of 214. Worth a note, not a session.

## Where I stopped

Diagnosis is done and evidence-backed. Design is written but nothing is built and no code
has been touched. Build order: `happened_at` first (everything else reads it), then the
anchor pick and the `selectAction` swap, then `require_contact`, then the prompt deletion,
then the sequence and the reply click.

Scratch scripts used, all `scripts/_tmp_*` and safe to delete: `_tmp_anchor_audit.ts`,
`_tmp_anchor_supply.ts`, `_tmp_funnel.ts`, `_tmp_wedotv_trace.ts`, `_tmp_wedotv_scores.ts`,
`_tmp_sudden_policy.ts`, `_tmp_policy_hist.ts`. Kept, because it is what pins the
correction at the top: `_tmp_refusal_shape.ts`.
