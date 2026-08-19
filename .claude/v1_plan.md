# v1: what to build, what to cut, and how a founder turns it on in an afternoon

Written 2026-08-18. Answers the whole brief, not just the bad first line.
Drafting mechanics (the anchor, the ask, what gets deleted from the prompt) are worked out in
`outreach_v1_plan.md` and are carried forward here rather than repeated.

---

# v1: the plain version

No internal vocabulary in this section. The detailed version, with the measurements and the
code-level calls, starts below at "The questions this answers".

## What it does

You have a list of companies you'd like to sell to. Two thousand, say. On any given day almost
none of them are doing anything that concerns you. A handful just did something that gives you a
real reason to get in touch: they launched a thing you plug into, they hired the person who owns
this problem, they signed a deal that changes their costs.

You can't read two thousand companies. So this does, at whatever pace your budget buys. At the
fifty dollar default that is about thirty-five companies a day, best ones first, and a company
that keeps producing news gets re-read far more often than one that never has. When it finds
something real it writes the message and shows it to you with a link to the page it read and the
date on it. You send it or you don't.

When nothing happened, it tells you nothing happened. That is the product.

## Why the messages were bad

We had it backwards. The system decided a company was worth writing to by asking an AI to rate how
interesting its news was, on a scale of zero to one. Then it handed a second AI the whole pile of
what we knew and said "write something."

So you got a message that opened by telling a company it runs a free ad-supported streaming
service. That is not news and it is not a reason. It is the AI having nothing to say and saying it
anyway.

The fix is to pick the specific thing that happened first, before deciding whether to write at
all. One event. It has a date, it is recent, it is something the company did rather than something
it is, it is not a topic you have told us to stay away from, and you have not already mentioned it
to them. If no such thing exists, we do not write. And whatever that event is becomes the first
line of the message, so the reason we wrote and what the message says cannot drift apart. They are
the same thing.

That one change lets us delete about a third of the instructions we give the AI, because most of
those instructions exist to help it guess at a question we can simply answer.

## Why it will sometimes send you nothing

This is the most important decision in here.

You tell it how many messages you can send in a day. That number is a ceiling, not a goal. If
three companies did something today, you get three. It does not go looking for seven more to fill
the gap. There is no path anywhere in the system where being short today makes it search harder,
lower the bar for what counts as news, or write something on nothing.

The only thing your numbers can ever do is stop work. If you already have forty good ones waiting
and you send twenty a day, it does not spend money researching today. That is the single place a
number touches spending, and it only ever points at spending less.

Money works the same way. You set a monthly budget. It spends up to that, best companies first,
and if that turns up nothing worth writing about then that is the answer. If you want more volume
you raise the budget yourself, on purpose. It never raises it for you.

Every other tool in this category makes money when you send more, because they charge per seat or
per send. That is why none of them ship a product that will tell you to do nothing today. We
charge for compute you buy directly from the provider, so volume earns us nothing, and that is the
only reason we can build the restrained version.

## Follow-ups

A follow-up sequence here is a schedule of when to put someone back in front of you. It is not a
robot sending on a timer.

Three rows. Day 0, the first message, short. Day 4 if they have not replied, one line about what
you do plus a specific offer. Day 7, the easy out. If they reply, the rest cancels.

That is why we do not need to build a sending engine, and why LinkedIn and email end up being the
same code. On email, approve means it sends. On LinkedIn, approve means you are pasting it right
now. Everything on either side of that is identical.

It also settles the thing you could not figure out about how to end a message. The ending is not a
property of the message. It is a property of where you are in the conversation. First message:
they have never heard of you, so the only thing you can ask for is a reply, and at 300 characters
there is no room to both explain yourself and ask for something. Second: now you have earned a
sentence about what you do, so make the offer. Third: give them the easy no. Then stop. The ending
gets picked by which step it is, not by the AI choosing off a list, which is why every message was
ending with the same sentence.

## Setting it up

Five questions, then it runs.

1. What do you sell, and to whom. One paragraph.
2. Your list. Upload a spreadsheet.
3. LinkedIn or email.
4. Paste one to three messages you have actually sent and liked. This replaces the current setup,
   which asks you to describe your tone with adjectives and fill in four template messages.
   Adjectives do not produce a voice. Your real messages do.
5. What you will spend a month. Fifty dollars is the default.

Then it runs immediately on your real list, in front of you, and produces three real drafts about
three real companies with the sources linked. Couple of minutes, about a dollar.

That last step is the product. Today a person uploads a spreadsheet and then waits until tomorrow
afternoon for a scheduled job. They are gone by then.

## What it replaces, and what it costs

Between a list and an outbox a founder normally pays for five things: something to build the list,
something to find email addresses, something to watch for news, a CRM to hold it, and something to
send. The cheapest honest version of that is around $270 a month, and that is with no real
news-watching at all, because the products that do that start at $625.

This does four of the five. It does not send. Measured on Sudden's real book, the compute is $49 a
month, and $40 of that is web searches bought at cost.

The comparison easiest for a buyer to check: reading every one of two thousand companies once a
month costs $254 to $279 on Attio and $92 here, at our measured $0.046 a company. Attio's cheapest
paid plan lets a founder research 150 companies a month. We ran 1,065 for $49.

The reason is not that we are clever. A web search costs about a penny and credit stores resell it
at ten to fourteen cents. Say that out loud, because a technical buyer will work it out and then
stop believing the rest of the pitch.

## What we are not building

No sending infrastructure. No inbox warming, no domain rotation, no bounce handling. Instantly
sells that for $37 a month and is better at it than we would ever be. When someone needs real
volume we hand them off.

No automatic reply detection yet. One button for now.

No meeting booking. Nothing sends without you.

## The honest problem

Sudden's list may not support twenty messages a day at any budget. In the last thirty days, 79
companies on it did something worth writing about. That is about two and a half new reasons a day.
Twenty of those seventy-nine had someone we could actually reach.

Today we produce 0.77 drafts a day. The changes above roughly double that on their own, and
dropping the contact requirement for LinkedIn roughly quadruples the pool. Getting to twenty a day
needs either more companies on the list or more frequent research, and that is now a budget
decision you make on purpose instead of a threshold nobody understands.

I would rather say that to a prospect than have no answer, which is where we are today.

---

## The questions this answers

1. Why the Wedotv first line was garbage, and the fix that comes from removing things.
2. How the ending of a message gets decided.
3. Should the system write drafts on its own.
4. What the internal rules around drafts should be, and who owns each decision.
5. How a founder sets up their own sequence so the thing runs with them watching.
6. What v1 is and what it deliberately is not.
7. What it costs, what it replaces, and why that is hard to say no to.

Numbers 1 and 2 were answered last session. 3 through 7 are answered here.

---

## Three measurements taken today that changed my mind

**The human is not the bottleneck. Supply is.**
Sudden has asked for 46 approvals ever. 25 approved, 16 rejected, 5 waiting. Median time from
request to decision is 1.9 days, worst ever is 7.3, and the most recent decision was two hours
ago. The 28-deep undecided pile I quoted in the pitch review is the demo workspace, which is
paused on purpose, and those are 48 days old. Sudden's queue is not clogged. It is starving.
46 drafts in 60 days is 0.77 a day.

**Ten of the 25 approved messages went out as written. Jake rewrote the other 15.**
Against 46 requests that is a 22% clean-approve rate. Of the 16 rejections, 4 are bookkeeping for a redraft of the same account and
9 fall inside 17-19 July, the two days the call site dropped `templates` and the drafter wrote
value-prop garbage. Strip those and recent quality is decent. The edit notes are specific and
consistent: "you forgot the actual ask", "reads like a news report", "too long", "the offload %
line is confusing", "live broadcast, not our market", "why is this in spanish?". Every one of
those is a decision the prompt handed to the model.

**Nobody has ever tuned a threshold.**
Sudden's `policy.routing` is `{}`. All twelve routing numbers are sitting at the code default:
draft at 0.65 fit, 0.70 signal, 0.50 evidence, 14-day suppression, and so on. The one real
customer, six weeks in, with a whole settings page available, has changed none of them. That is
not neglect. Those numbers are unpicturable. A founder cannot tell you what 0.65 fit means, and
neither can I without opening the rubric.

Two more that matter for sizing: 1,961 live accounts and 282 contacts (the "2,243 accounts" in
the pitch review is entities, not accounts, and needs fixing). 126 accounts have any contact
attached at all, and 70 have one scoring high enough to write to. That is 3.6% of the book.

---

## The answer in one paragraph

Stop deciding whether to write by reading a score. Decide it by asking whether a dated thing
happened that this customer is allowed to write about. That test is the only thing permitted to
say "none today", and nothing may override it. Everything else is either a ranking (who goes
first) or a limit (how many land in front of you, how much we spend looking). No number anywhere
in the system is a target.

**Corrected 2026-08-18, after Jake pushed back.** An earlier version of this section said the
founder sets a daily number and "the system fills that number and stops." That is a target and it
is wrong for exactly the reason he named: a system that owes you ten messages will find ten
messages, and the only places left to find them are the judgment calls. The rule is one
asymmetry: **the founder's numbers may only ever turn spending off, never on.** Being short buys
nothing. Being ahead buys less. See "The four limits" below, which replaces "The two numbers".

---

## Whether, who, how many: three separate jobs done by one thing today

Right now a score decides all three, and it is bad at all three.

- **Whether to write** is decided by `signal_strength >= 0.7`. That rubric asks how actionable
  the most recent signal is for what we sell. It is a fit question wearing a timing costume.
  Nothing in it asks whether anything happened. Wedotv scored 0.70 on seven launches the drafter
  then refused to use.
- **Who to write to first** is decided by the same score. It ties. 1,060 accounts sit at 0.84 on
  identical imported evidence. Two attempted fixes to the formula both made it worse.
- **How many to write** is not decided at all. It is whatever falls out.

Split them:

| job | decided by | shape |
|---|---|---|
| may we write to this account at all | is there an anchor | yes / no, checkable by eye |
| who goes first | the fit score | a ranking, no cut-off |
| how many land in front of you | your send capacity, defaulted from the channel | a ceiling, never a target |

An anchor is one fact that happened, is dated, is inside the freshness window, is not a subject
this customer said never to write about, and has not been used in an earlier message to this
account. It is the reason we acted and it is the first line of the message, so those two can
never disagree again. Full definition and the prompt deletions it allows are in
`outreach_v1_plan.md`.

The important property of this split is that a collapsed score stops being fatal. A tie at 0.84
across a thousand accounts is harmless when the score only orders a list. It is ruinous when the
score is the cut-off, because either all thousand pass or none do. We already lived that.

---

## Should the system write drafts on its own

Yes, and the rule that makes it safe is one line:

> Write for the touches due today, up to your send capacity, minus whatever is still undecided.
> If fewer are due, write fewer. Never write to fill the gap.

A touch is one planned message to one person: which account, which step of the sequence, when it
is due, and which fact it is anchored on.

With a capacity of 20 and 5 undecided, it writes at most 15. With 20 undecided, it writes nothing
and says on the page that it is waiting. With 3 anchored accounts, it writes 3. That single subtraction:

- makes a pile-up structurally impossible, so the demo workspace's 48-day-old stack of 28 cannot
  happen again
- caps the daily bill without ever raising it
- keeps drafts at most one day old, so nothing rots in the queue
- turns "you are behind" into something visible instead of silent rot

The alternative, writing only when a human opens the card, saves pennies and costs the thing the
product is for. The founder should open the page and find the work done. Drafting is about one
cent; search is 86% of the bill. Writing ahead is the right trade at any queue depth this rule
allows.

---

## The internal rules around drafts

One principle: **the system decides, the model writes.**

Every place the prompt currently asks the model to choose something is a place a rule got pushed
into a paragraph, and most of them have already produced a bug we fixed once.

| decision | today | v1 |
|---|---|---|
| write at all? | model, after reading everything | code: is there an anchor |
| what does it open on? | model picks from a similarity-ranked fact list | code: the anchor |
| which problem does it argue? | model picks from a menu | code, `pickDraftAngle`, already built |
| which template? | model matches the recipient's job title to audience lines | deleted |
| how does it end? | model picks from a ranked menu of four | code: from the step's purpose |
| how long? | prompt suggests a number | code: from the step |
| what may it claim? | config | config, unchanged |
| what must it never say? | config | config, split in two (see below) |
| what does it sound like? | tone adjectives plus four written templates | one to three real messages the founder pastes |

The model is left with one job: turn one dated fact and one problem into N characters in the
founder's voice. That is a job a cheap model does reliably, which matters because it is the only
per-message cost.

Two config fields where there is one today, because Wedotv needs both to exist separately:

- **who you cannot help.** Vetoes the account when it is scored.
- **what is never the subject of a message.** Vetoes a fact as an anchor.

Wedotv is sellable and everything we know about it is unwritable. Today that state has nowhere to
live, so the drafter wrote about the company description instead. Split, the honest outcome is "no
anchor, go research their catalog", which is what should have happened on 15 August. Zee5 has been
producing the same refusal every night for five days for the same reason.

---

## Sequences, and the thing that makes them cheap

The sequence is a schedule of what to put in front of the founder, not a schedule of what to send.

That one sentence removes the need for a sending engine, and it is why LinkedIn and email can be
the same code. On LinkedIn, approving means "copy this, I am pasting it now." On email, approving
means Resend sends it. The scheduling either side of that is identical.

Config is three fields per step:

```
outreach.sequence: [
  { after_days: 0, purpose: "open",  max_chars: 300 },
  { after_days: 4, purpose: "offer", max_chars: 400 },
  { after_days: 7, purpose: "close", max_chars: 300 },
]
```

`purpose` is one of three values because each maps to a fixed rule about the ending. Free text
would put the decision back inside the model, which is the thing being removed. Step count is
free. Sudden's real process is exactly these three rows: connection request with a note at 300
characters, DM after the accept at 400, then a bump.

The ending comes from the step, which is the answer to "sometimes a question, sometimes a real
ask, sometimes more about us, sometimes nothing." It was never a property of the message. It is a
property of where you are in the conversation:

- **Step 1.** They have never heard of you. The only thing you can ask for is a reply. End on the
  question, offer nothing. At 300 characters there is no room to explain yourself and ask for
  something, which is what the current prompt spends a paragraph failing to resolve.
- **Step 2, no reply.** Now one sentence about what you do has been earned. Offer the specific
  thing you would produce for them.
- **Step 3.** The easy out. A question they can close with one word gets answered.
- **Then stop.**

This is also why the closing line came out word-for-word identical across messages: it was the
last thing written, chosen by the model from a fixed list, and the only part with no
account-specific input.

Two rules stay in code, not config:

- **Only step 1 needs an anchor.** A follow-up four days later is not opening cold. Requiring a
  fresh event there would mean inventing one. This is where the market-brief work, built and
  dormant since 1 June, finally belongs.
- **A reply ends the sequence** and hands the account to the human.

### The one new table

`touches`: account, contact (nullable), step, due date, anchor fact id, status.

The watcher creates step-1 touches when it finds an anchor. Approving one creates the next step's
touch, due `after_days` later. A reply cancels the rest. Every morning the pass writes drafts for
what is due, capped by the rule above.

This is the only schema addition besides `happened_at` on facts. It earns a table rather than a
fact because a fact is something that is true now and an event is something that happened; a
scheduled future action is neither, and forcing it into facts is exactly the shape that produced
the supersede bugs already in the log.

The missing piece: `replied` is a defined transition in `lifecycle.ts` and nothing in the codebase
ever sets it. Until one click records a reply, step 2 will fire at people who already answered.
One button on the approval card. It is an action on a decision, not a browsable list, so it stays
inside the rules in CLAUDE.md.

---

## Contacts: derive it from the channel instead of asking

On LinkedIn you find the person inside LinkedIn. Their search is better than any contact provider
and it is free. So buying contact data for a LinkedIn workspace is paying for something the founder
is going to do by hand anyway thirty seconds later.

On email you cannot send without an address, so it is mandatory.

So requiring a contact before drafting is not a separate question at setup. It follows from the
channel the founder already picked. LinkedIn: off. Email: on.

That matters more than it sounds, because half the accounts that clear every score bar today have
nobody attached, they queue for a contact pull, Hunter comes back empty, and they sit there every
night. Last night's pass: 400 scanned, 12 contact pulls attempted, 0 contacts created, 0 drafts.

When there is no contact, the drafter is told it is writing to the company and must not use or
invent a name. The message opens on the anchor, which it was going to do anyway. "Saw Stingray
signed with Titan OS for nine channels across Europe" needs no name. The founder adds one when
they paste it if they want.

---

## The four limits

None of these is a goal. Each one can only reduce what happens, never increase it.

**1. The anchor test. Decides whether we may write at all.** Fixed in code, identical for every
workspace, and the only thing in the system allowed to answer "none today". No budget, no
shortfall, no configuration loosens it. If it says no, we do not write, and the honest output for
the day is zero.

**2. The fit score. Decides who goes first.** A ranking with no cut-off, which is what makes the
0.84 collapse harmless.

**3. Send capacity. Caps how many land in front of you at once.** Default it from the channel:
20 for LinkedIn, 50 for email. This is not a question at setup, because it is a fact about the
account you send from, not a decision. A day that produces 3 anchored accounts gives you 3. A day
that produces 40 gives you 20 and the other 20 wait; they do not expire, they are still anchored
tomorrow. Minus whatever is still undecided, per the write rule above.

**4. The monthly dollar cap. Decides how much we spend looking.** Default $50. Converted to a
daily allowance, spent best-fit first, in this order, and never on a step whose output the next
step cannot use:

1. Write what is due. About a cent each.
2. Contacts, but only for accounts that already have an anchor, and only if the channel needs one.
3. Research, best-fit first, for accounts that can be reached and have no anchor.
4. Resolve domains for accounts that have none, because those can never be researched at all.

Step 2 is currently backwards. We research accounts we cannot reach and buy contacts for accounts
we have no reason to write to. 59 of the 79 accounts with a fresh dated event have no contact.
Reordering costs nothing to implement and is the fix for the $2-per-used-fact number in the cost
review.

### The one place a limit touches spending, and the direction it may go

If the standing queue of anchored accounts already covers the next few days of sends, spend
nothing on research today.

That is a brake and it is the only interaction allowed between capacity and spend. The reverse,
"we are short today so search harder", must never exist. Research at a fixed daily allowance
regardless of shortfall. A founder who wants more volume raises the dollar cap themselves, once,
deliberately. The system never does it on their behalf.

Together these replace twelve routing thresholds, `searches_per_run`, `domain_backfill_per_day`,
`max_contact_pulls_per_run`, and the research cooldowns. Those stay in the code as derived values.
They stop being questions anyone is asked.

### Count anchors separately from drafts

Today a day with zero drafts is indistinguishable from a day something broke, so every zero gets
read as a failure. That reading is how a restrained system turns into a volume system: someone
looks at four zeros in nine runs and starts loosening things.

Two counts, side by side, fix it. Zero anchored accounts means the world was quiet and the day
was correct. Forty anchored accounts and zero drafts means we are broken. The anchor test is what
makes those separable for the first time, and the daily digest should carry both numbers before
anything else.

## What the founder does, start to finish

Five questions and a live run. Twenty minutes, plus whatever the CSV takes.

1. **What do you sell, and to whom?** One paragraph. Exists today, and the derive step already
   produces the problems you solve, the claims you are allowed to make, who you cannot help, and
   the writing rules.
2. **Your list.** CSV upload, already in the creation flow, or connect a source.
3. **How do you reach people?** LinkedIn or email. Email asks for a sending key. LinkedIn says
   plainly that sending is copy-paste and that this is fine at twenty a day.
4. **Paste one to three messages you have actually sent and liked.** Skippable. This replaces
   tone adjectives and the four-template block, both of which are more work to fill in and worse
   at carrying voice. Sudden's four templates have been switched off since 14 August and switching
   them back on switches the job-title refusal back on with them.
5. **How much a month?** Default $50. Send capacity is not asked; it comes from the channel
   picked in question 3, and is editable later for anyone whose account differs.

Then the part that sells it: **it runs once, immediately, small, on their real list.** Takes the
20 best-fit accounts from the CSV, researches a handful, writes three, and shows them with the
source pages linked and dated. About a dollar and a few minutes, with the steps visible while it
works.

That is the demo, the onboarding and the product on the same code path. A founder who uploads a
CSV and then waits for tomorrow's 14:30 cron has already left.

Last, the sequence: show them the three default steps already filled in and say this is when each
person comes back to you. Three rows. Most people will not touch it.

Two things have to be true and neither is today: the pass needs an entry point that runs on a
named set of accounts with a count, and research plus drafting has to finish inline in a couple of
minutes for twenty accounts.

---

## What v1 is not, and say it out loud

- **No sending machinery.** No mailbox warming, no domain rotation, no bounce or complaint
  handling. Instantly and Smartlead sell it for $37 a month and are better at it than we will ever
  be. When someone needs volume, we hand off to them.
- **No automatic reply detection.** One click on the card for now. Doing it properly needs mailbox
  write access we do not have.
- **No meeting booking.**
- **Nothing sends without the founder.**
- **No messages without a reason.** There is an honest message that needs no anchor: lead with
  what you see across the category and ask whether it applies. It is a real volume lever and it is
  the one setting that would erode the entire value story. Design it, leave it off.

---

## What this replaces, and what it costs

Between a list and an outbox a founder normally buys five things: a list tool, an email finder, a
signal monitor, a CRM to hold it, and a sequencer. Cheapest honest stack that watches two thousand
companies continuously is roughly $270 a month, and that is with no real signal monitoring at all,
because the products that do it start at $625.

We do four of the five. We do not send. On Sudden's book the measured compute is $49 a month, of
which $40 is web search bought at wholesale.

The sharper version of the comparison, because it is one number a prospect can check in five
minutes: reading every one of two thousand companies once a month costs $254 to $279 on Attio Pro
and $92 here, at the measured $0.046 a company. Attio's cheapest paid plan caps a founder at 150
research runs a month. We ran 1,065 for $49. Do not say "$49 watches two thousand companies": $49
bought 1,065 research passes over 534 of them, and a buyer who divides will catch it.

The reason is a markup, not cleverness, and it has to be said that way or a technical buyer catches
it and stops believing everything else. A web search costs about a penny. Credit stores sell it for
ten to fourteen cents.

### Why this is hard to say no to

Not the price. Price makes it easy to try.

Every outbound tool on the market makes money when you send more, because they charge per seat or
per send. So none of them can ship a default that sends less. We charge for compute you buy
directly from the provider, which means volume earns us nothing, which means we can build the only
one whose normal behavior is to tell you there is nothing to do today.

That is the position: **it will not write a message when it has no reason, and the reason is a
dated page you can click.** First-generation AI SDRs raised touch counts 6.4x and watched positive
replies fall to 1.3%, under the 2.1% human baseline, and about half of pilots were switched off
inside 90 days. Inbox rules have tightened since. The volume play gets worse every year on both
axes, and cheaper models make the restrained play cheaper every year. That is the part that scales
past a founder tier: the same machine sold to a team where every claim linking a dated source is
what lets them do outbound at all. Not a v1 move, but it is the reason v1 is worth building this
way rather than the easy way.

---

## What this costs us in volume, honestly

It does not cost volume. It roughly doubles it, and then hits a different ceiling.

79 accounts have a dated event in the last 30 days. 49 of those are blocked by `signal_strength`
alone, including a Stingray agreement with Titan OS for nine channels across Europe and a BT Sports
multi-year boxing deal, both scored 0.4 for "passive presence". Requiring an anchor instead of a
score unblocks them.

The ceiling behind it is real and worth stating before a prospect finds it. 20 of those 79 have
someone to write to. Against a 14-day gap between messages to the same account that is about 1.4
drafts a day, and we are producing 0.77. Turning off the contact requirement for LinkedIn roughly
quadruples the pool. Getting to 10 a day on this book needs the event supply itself to be higher,
which means more accounts or more frequent research, and that is a budget decision the founder now
makes directly, once, by raising the monthly cap. The system never raises it on their behalf.

I would rather have that conversation with a prospect than not have an answer at all, which is
where we are today.

---

## Build order

Each of these is useful on its own and none of them breaks the one before it.

1. **`happened_at` on facts**, nullable, written by the enricher at extraction, null when it is not
   an event. Three places currently re-derive a fact's time meaning with their own guesswork, and
   the "unknown date defaults to today" bug has now been fixed separately in three places. One
   column closes the class. Backfill by classifying once over accounts above the fit floor with a
   source date in the last 90 days. Do not copy source dates onto every fact; a company profile
   page has a publication date and the description on it is still not an event, which is precisely
   the Wedotv failure.
2. **The anchor pick, and take `signal_strength` out of the draft conditions.** Leave the scoring
   weights alone so no full-book rescore fires. `signal_strength` stays a scoring dimension; it
   stops being a condition.
3. **Contact requirement follows the channel.** Smallest change on the list, largest immediate
   effect on the pool.
4. **Delete from the drafter prompt what the anchor makes unnecessary.** The trigger-mode section,
   the ranked ending menu, the template audience matching, tone adjectives. Grade before and after
   with `_dryrun_drafts.ts`, which already exists and does not write to the DB.
5. **The touches table and the sequence.** Three rows of config, the daily cap with the undecided
   subtraction, and the reply button.
6. **Setup: the monthly cap, the pasted examples, and the live first run.**

1 through 4 make the drafts right. 5 makes it a sequence. 6 makes it something someone else can
turn on without us.

---

## Where I am least sure

**The freshness window.** 14 days leaves 22 accounts standing, 30 leaves 79. I am going with 30
for this market. It is a judgment about how fast news dies in streaming, not a technical call, and
it is one field.

**Whether one click is enough to record a reply.** Sends are manual copy-paste, so the founder is
already in LinkedIn when the reply arrives and clicking back here is real friction. If it gets
skipped, step 2 fires at people who already answered, which is the worst failure this design has.
Building it as one button and watching whether it gets pressed is the cheap way to find out.

**Whether the live first run can finish in two minutes.** Research is the slow part and it is
outside our control. If it cannot, the setup ends on "we are working, come back in ten minutes"
and loses most of its force. Worth prototyping before committing to the rest of the setup flow.

**The event supply on a 2,000-company media book.** 79 fresh dated events in 30 days is about 2.6 a
day of new reasons to write. Ten a day may not be reachable on this book at any budget. If that
holds, the honest product for Sudden is five a day, and the founder's number should default from
what the book can actually support rather than from what LinkedIn allows.
