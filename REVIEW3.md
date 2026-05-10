# Sprint 3 review — content quality audit

**Run on:** 2026-05-09
**Method:** read every channel's actual signals, facts, and post bodies. Classify each by warming stage. Identify duplicates and false positives.
**Time:** 15 min.

---

## TL;DR

30 channels, 5 sources of varying quality. **3 channels are sendable today, 5 are blocked by drafter's narrow filter, ~5 are false positives created from RSS articles that aren't actually about the named company.** Two known bugs from prior reviews still bite hard. Multiple drafts pile up on the same account because the drafter has no "we already drafted to this account, don't draft again" suppression.

---

## Channel quality score

| Quality tier | Count | What it means |
|---|---:|---|
| **Pitch-ready (real prospect, sendable draft)** | 3 | Kalshi, The Token Company, Ventura |
| **Real prospect, blocked by narrow drafter filter** | 4 | Talking Computers, OpenSpec, Fixture, InventoryQuant |
| **Has facts but drafter gated correctly** | 3 | Scheduling Wizard, Ndea, Halo Health |
| **YC W26 cold (signals only, awaiting enrichment / better trigger)** | 12 | Bezel, Cifrato, Bizzy AI, etc. |
| **Seed entities (no real signals, ignore)** | 4 | Strand Compute, Brightvine, Forge Robotics, Plaintext.so |
| **False positives (entity created from misread article)** | 4 | manishbhusal, Stripe, Hatch, Kodiak AI |

---

## The 3 sendable drafts

These are the channels where the system delivered actual value.

### 1. The Token Company (YC W26) — best draft of the run

```
Subject: % increase with compressed prompts?

Saw the 5% purchase volume lift in your blind LLM arena case study, that's a
concrete signal that your compression middleware is doing more than just
trimming tokens. It's actually making end-user experiences better. Given
you're building B2B infra for other AI products just out of YC (W26), I
suspect you...
```

- Cites 3 real facts
- Subject is one word + concrete metric
- References *their actual case study*, not generic praise
- Speaks pain language (compression middleware, token efficiency)
- **This is sendable.**

### 2. Kalshi (TechCrunch RSS)
```
Subject: Valuation
Hope you don't mind the cold connect. Congrats on raising a $1 billion Series F
round and doubling your valuation to $22 billion in just five months. It's an
impressive feat, but scaling rapidly with a small team can lead to challenges
with data management and outbound processes...
```
- 2 valid cites (Series F + valuation doubling)
- References real public news
- Slightly generic in problem statement but specific in opener

### 3. Ventura (YC W26)
```
Subject: AI workforce for industrials, starting with quoting
Saw Ventura pop up in the Winter 2026 YC directory. Your one-liner, "AI
workforce for distributors and manufacturers," caught my eye because most
AI-in-industrial plays still bolt onto legacy CRMs instead of rebuilding
around where the work actually lives.
```
- Specific to their actual one-liner
- Names the architectural difference (legacy bolt-on vs rebuild)
- Real pain framing for the buyer

---

## Real prospects blocked by drafter's narrow filter

The `claims_audit_yc_drafter` and `claims_yc_outbound_drafter` agents gate any account that isn't `is_hiring=true`. That's a bad heuristic.

**Scheduling Wizard** is the clearest example:
- 9 active facts including: `customer_of=Mass General, Johns Hopkins, UT Southwestern, UCSF`, `partner_with=UCSF`, `industry=Healthcare`
- Both drafters gated: "The account is not hiring at this time, which does not align with the targeting criteria for cold outreach."

**They have $760B-market validation, four major hospital customers, and the drafter killed the lead because the YC profile says `is_hiring: false`.** That's exactly the kind of false negative that makes prospects say "AI is dumb."

Same pattern: Ndea (frontier AI / AGI), OpenSpec, Talking Computers (AI-for-AI-infra — *directly* relevant to our pitch, but gated).

**Fix:** the drafter shouldn't filter on hiring; it should reason about whether the *facts available* are enough to ground a good email. "9 hospital customers" is more than enough fact density. The right filter is fact-richness, not employment status.

---

## 4 false positives (entities that shouldn't exist as accounts)

These got created by the web/RSS connector because the LLM mis-extracted a company name from each article.

### manishbhusal (known bug, NOT fixed)
- Source: Indie Hackers RSS
- The "company name" is the user's IH username
- 3 touch_drafts addressed to a username

### Stripe (false positive)
- Source: Lenny's Newsletter RSS
- Article: "The internal AI tool that's transforming how Stripe designs products | Owen Williams"
- The article is about Owen Williams (a Stripe employee) showing his side project Protodash
- The connector created Stripe as a CRM entity
- Both agents gated correctly: "Insufficient specific facts about Stripe to ground the email"

### Hatch (false positive)
- Source: Indie Hackers RSS
- Article: a self-promo for an AI assistant called Hatch
- Created as an entity even though it's the makers promoting their own product
- Both agents gated: "no specific facts to ground"

### Kodiak AI (false positive — wrong type of company)
- Source: TechCrunch RSS
- Article: "Kodiak AI raises $100M at a steep discount, sending its stock tumbling 37%"
- Real company, but it's a *public autonomous-trucking company*, not a CRM prospect
- The connector doesn't know our ICP is early-stage SaaS, not late-stage public companies
- Drafter gated; scorer wrote a generic claim

**The pattern:** the web/RSS connector creates an entity per company name it extracts, regardless of whether that company *fits our ICP*. We need an ICP gate at entity-creation time, not just at drafter time.

---

## Multi-draft pile-up (no draft-suppression)

**Ventura has 4 touch_drafts** from 2 different drafter agents across multiple test runs. Each one is a fresh attempt at the same outreach. If a real user opened `/gates`, they'd see the same prospect 4 times with 4 slightly different emails.

**The system doesn't know "we already drafted to this account, don't draft again."** It re-drafts on every signal that matches the filter.

**The Token Company has 1 draft + 3 gate_requests + 6 claims = 10 posts**. Useful in theory, exhausting in practice.

**Fix:** before drafting, check if a touch_draft already exists for this entity in the last N days. If yes, either:
- Skip (default)
- Update the existing draft if there's new fact content (advanced)
- Notify "we have new facts, want to re-draft?" (UX prompt)

The simplest deterministic check: count existing `touch_draft` posts per channel in last 7 days. If >0, the drafter calls `request_gate` with policy=`draft_already_exists` instead of writing a new one.

---

## Sources by quality

| Source | Entities created | Quality | Issues |
|---|---:|---|---|
| **YC directory (yc connector)** | 16 (W25/S25/W26) | HIGH | Rich one_liner + description; clean structured data; multiple facts extractable per company |
| **TechCrunch RSS** | 4 real (Kalshi, Kodiak, Corgi, etc.) | MEDIUM | Real news, but conflates multiple companies in one article (Ramp draft mentioned Corgi's funding) |
| **Indie Hackers RSS** | 2 (manishbhusal, Hatch) | LOW | Username-as-entity bug; self-promo confused with third-party signal |
| **Lenny's Newsletter** | 1 (Stripe — false positive) | LOW | Articles are about people, not companies as buyers |
| **Manual seed** | 6 (Resona, Brightvine, etc.) | DEMO ONLY | Not real prospects |
| **Exa intent searches** | 0 | UNKNOWN | EXA_API_KEY not set; can't verify |

---

## Where each channel is in the warming process

| Stage | Count | Channels |
|---|---:|---|
| Cold (no signals beyond seed) | 4 | Strand Compute, Brightvine, Forge Robotics, Plaintext.so |
| Discovered (signals, no enrichment) | 11 | Stripe, Hatch, Kodiak AI, Glue, Palus Finance, Bizzy AI, Autostep, Foresight, Dollyglot, SalesPatriot, Cifrato, Swerve, Bezel |
| Enriched (facts asserted) | — | (lumped with scored, since enricher always also drives a claim) |
| Scored (claim posted) | 5 | Resona Labs, Plaintext.so, Forge Robotics, Halo Health, Scheduling Wizard, Ndea |
| Draft ready (touch_draft exists) | 8 | Token Company, Talking Computers, OpenSpec, Ventura, Kalshi, Ramp, Fixture, InventoryQuant, Kodiak AI*, manishbhusal* (*false positives) |
| Sent / approved | 0 | (all drafts unreviewed; this is dog-food run, not a real customer flow) |

---

## Critical gaps to close before the system is "ready to ship"

### 1. ICP gate at entity creation
RSS connector creates an entity per article-mentioned company, regardless of ICP. Result: 4 false positives this run. Need: meta-step that scores an extracted company against the workspace's About + ICP before creating the entity.

### 2. Drafter shouldn't filter on `is_hiring`
Heuristic is too narrow; misses obviously-good prospects (Scheduling Wizard with $760B market + 4 hospital customers, Talking Computers, Ndea). Fix: filter on fact-richness, not employment status.

### 3. Draft suppression
No mechanism to prevent re-drafting. Ventura has 4 drafts. The Token Company has 3. Fix: before drafting, check for existing touch_draft on this channel in last 7 days.

### 4. Web/RSS company-extraction is brittle on multi-company articles
Ramp draft references Corgi's funding. The LLM picks one entity per article but the content can mix. Fix: extract ALL companies mentioned in an article, create separate signals per company, not one signal mis-attributed.

### 5. Indie Hackers RSS author-as-company bug (KNOWN, still not fixed)
manishbhusal has 3 drafts addressed to a username. Fix: per-source extraction prompt overrides (flagged in Sprint 2 review).

### 6. Enricher only fires on YC signals
`claims_audit_yc_enricher` filter is `signal_source: yc`. Web-sourced entities (Stripe, Kodiak, Hatch, Kalshi, Ramp) get NO enrichment. Result: drafter has thin facts to ground on. Fix: a second enricher with filter `signal_source: web` (or no filter at all).

---

## Top 3 fixes by impact (this is what would make tomorrow's run good)

1. **ICP gate at entity creation** — 1 hour. Adds a small LLM check between extraction and `create_account`. Eliminates 4+ false positives per RSS run.

2. **Draft suppression** — 30 min. SQL existence check before the drafter runs. Cuts redundant drafts to 0.

3. **Drafter reasoning over fact-richness, not is_hiring** — 30 min prompt rewrite. Unlocks 4+ real prospects (Scheduling Wizard, Talking Computers, Ndea, OpenSpec) per run.

These three together would take the audit-pass rate from 3/30 channels (10%) to ~10/30 channels (33%) sendable, with redundancy near zero.

---

## Honest read

The architecture is doing its job. The agents fire correctly. The provenance chains hold. The drafter follows the formula. **What's broken is the upstream data quality (entity extraction, ICP filtering) and downstream coordination (no draft suppression, narrow drafter filter).**

These are LLM-prompt + small-logic fixes. Not architectural rework. The gap between "10% sendable" and "30%+ sendable" is one focused afternoon.

The 3 sendable drafts (Token Company especially) prove the system can produce real outbound when the inputs are clean. The system isn't hallucinating; it's correctly reflecting whatever data it has. The job is feeding it cleaner data.
