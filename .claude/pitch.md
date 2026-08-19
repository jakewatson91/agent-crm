# The pitch

Working version, 2026-08-16. Numbers measured on Sudden over the prior 30 days. The review behind it,
including every competitor price and where we lose, is in `pitch_review_2026-08-16.md`.

Buyer: a founder before their first sales hire, with a list of a few thousand companies and about
five minutes a day for sales.

---

## Open here

> You have two thousand companies you could sell to and five minutes a day. Right now some of them
> are hiring a head of sales, or shipping the thing you plug into, or raising. That is the reason to
> write to them, and it expires in about two weeks.
>
> This reads all of them every day and hands you the two or three where something actually changed,
> with the email already written and the page it came from linked, dated. You say yes or no. That is
> the whole job.

---

## Why it costs what it costs

Every tool that will do this meters how many companies you are allowed to look at. Attio's cheapest
paid plan gives you 150 company research runs a month. HubSpot charges ten cents a research task and
a dollar every time it recommends someone. Watching a two-thousand-company list that way is about
$254 to $279 a month on Attio Pro before you count the seat.

A web search costs about a penny. We ran 1,065 research passes over 534 companies last month and the
total bill, searches and models and everything, was under $50.

**Say the reason out loud rather than implying it is cleverness: credit stores mark up a penny to ten
or fourteen cents.** You pay the search provider directly and we stop metering how much you are
allowed to know. This is a margin gap, not an efficiency gap, and a buyer who catches us dressing it
up stops believing the rest.

---

## Why the email is worth reading

The model never sees a database record. It sees separate facts, each tied to the page it came from
and the date that page was published, and it only sees pages that survived filtering. Of 11,405 pages
pulled last month, 9,429 were dropped as off-topic, too old, or repeats of something already known.

Judged blind against ground truth, drafts written off this data score **4.2 to 4.4 out of 5 on
relevance against 2.7 to 3.1 for the same model reading HubSpot's records.** Three separate judge
runs, same gap every time. They also carry fewer invented claims than HubSpot or Attio in every run.

The mechanism is worth one sentence: when the model gets handed a whole record it cannot tell a real
company fact from an internal field, which is how HubSpot wrote a suppression flag into an outbound
email in our test and Attio invented a funding round.

---

## The model is yours to pick, and that keeps paying

Point it at DeepSeek, Claude, GPT or Gemini. Paste a key, paste a model id, done. No dropdown, no
approved list, no upcharge for the good one.

This matters more than it sounds. Credit pricing hides what the model actually costs. HubSpot credits
have sat at a cent while model prices fell hard, so when the thing underneath gets cheaper, your bill
does not move. Here you pay the provider directly, so every price cut is yours the day it lands. If
you want better drafts, buy a better model at its real price instead of a bigger credit pack.

Where the data comes in, same story and stronger. Point it at any HTTP endpoint you like: paste the
URL, the headers, and where the list lives in the response, and it starts pulling. If the response is
messy, the other version takes the URL plus a sentence describing what you want out of it and writes
the extraction itself. No code, no adapter, no waiting on us to support your source.

Contact data: pick a provider, set a backup, no code change. Two are shipped today (Hunter and
Explorium).

**Do not say "any researcher" or "any sender" yet.** Web search is Exa only and sending is Resend
only. Truthful line as of today: *models and data sources are open to anything; contact data is
pick-from-two; search and sending are one each.*

---

## Order of proof when they push

1. **Per company looked at.** $0.046 here, $0.10 HubSpot, $0.14 Attio. On a 2,243-company book that
   is $49 against $254 to $279.
2. **Five minutes a day.** Approving is the only thing you do.
3. **The drafts are checkable.** Every claim links a dated page. 4.2 to 4.4 relevance against 2.7 to
   3.1 for the same model on HubSpot records.
4. **The real alternative is a hire.** An SDR is $90-154K a year fully loaded and takes 3.2 months to
   book a first qualified meeting.

---

## Objections

**"Why not point Claude at my CRM?"** The same model doing the same job through HubSpot's API costs
2.26x more per action and makes 3.44 calls where this makes one. And it writes internal fields into
outbound email, because through an API they look exactly like company facts.

**"Why not Twenty?"** Do not fight them on cost, you lose, they tie us. Twenty stores your data well
and has no research agent. Nothing in it watches the web or decides what is worth reading.

**"Why not an AI SDR?"** Be straight: they will send more than we will. They start at $1,800 a month
(Regie's ten-seat floor) and 11x wants a year up front at around $5,000 a month. Worth saying out
loud that first-generation AI SDRs raised touches 6.4x while positive replies fell to 1.3%, under the
2.1% human baseline, and about half of pilots were switched off inside 90 days.

---

## Never say

Nothing about how the data is stored. No provenance, no replay, no event sourcing, no content
addressing, no projections, no token-efficient reads.

Do not claim we are cheap because we are disciplined. Search is 86% of the bill and the filtering
happens after we have paid for it. The filtering is why the drafts are good, not why the bill is
small.

Do not put our $1.47 per draft next to HubSpot's $1.00 per recommendation. Ours divides the cost of
watching 2,243 companies by 23 drafts; theirs is a marginal price with a $90 seat and $1,500
onboarding outside it.

Do not imply we have measured HubSpot's Breeze agent. We have not. We measured a model reading
HubSpot's API records, which is a different product.

---

## What we cannot claim yet

Roughly 23 drafts a month. No sending at volume, no mailbox warming, no domain rotation. No reply
handling and no meeting booking. Setup still asks a founder to stand up a database. Against anything
quoting meetings booked, we have no answer.

The pitch is about deciding who is worth writing to. It is not about sending.
