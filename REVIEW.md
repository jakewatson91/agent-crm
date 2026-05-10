# Product audit — agent-crm v0

**Run on:** 2026-05-09
**Method:** simulated a "real user setting up the system to replace HubSpot/Salesforce" via the API surface that the UI calls. 3 sources, 3 agents, 10 fresh YC W26 entities pulled, 50 agent runs, 48 channel posts produced. No emails sent.
**Time:** 15 minutes.

---

## TL;DR

**Architecture is right. Execution has 6 specific gaps that bite a real user immediately.** Provenance + replay work as advertised. Drafts and claim outputs are below the bar required to actually replace HubSpot. Fixes are tractable, mostly prompt-tuning + ordering.

Score by dimension:

| Dimension | 1–10 | Notes |
|---|---:|---|
| Setup ease | 5 | Sources fail silently when meta-agent omits required fields. UI guidance is sparse. |
| Agent output accuracy | 4 | Enricher extracts redundant facts. Scorer produces generic fluff. |
| Draft quality | 3 | Drafts don't follow the constitution. Wouldn't send any of them. |
| Provenance / citation chain | 9 | Works end-to-end, two-hop walks resolve cleanly. Just not exposed in the UI. |
| Defensibility (architecturally) | 7 | The events + facts substrate is real moat. But the moat is invisible unless surfaced. |
| Defensibility (commercially) | 4 | Anyone with LLMs can build the surface-level agent loops. The moat is one-click replay + cited drafts. Neither surfaced today. |

---

## What I tried (real workflow)

1. NL-described 3 sources via `/api/sources/parse`:
   - "watch HN for posts mentioning AI CRM, agent CRM, or no-code crm"
   - "watch Lenny's Newsletter Substack for posts about CRM, GTM, or sales tools"
   - "pull active YC W26 companies"
2. NL-described 3 agents via `/api/agents/parse`:
   - ICP scorer (claim_poster)
   - Enricher
   - Outbound drafter
3. Ran each source via `/api/sources/run-now`. Then ran `process_unmatched.ts` to push every signal through every matching agent.
4. Read 3 sample claims, 1 draft, 8 enricher facts. Walked one full provenance chain.

---

## 6 critical findings

### 1. Sources created via NL fail on first run because meta-agent omits required fields

```
HN source created → run → "config.watch_entities is empty — nothing to match against" → ZERO signals
Lenny's source created → run → "intent=watch requires watch_entities to be non-empty" → ZERO signals
YC source → ran fine, 10 entities + 10 signals
```

What happened: the meta-agent emitted `watch_entities: []` for sources that *require* watch_entities, and `intent: watch` when it should have been `discover`.

**User experience:** click Create → click Run → "errors: ['nothing to match against']". No guidance on what to fix. A real user would assume the product is broken.

**Fix:** the parse endpoint should validate that the chosen connector + config combination is runnable. If watch_entities is required but empty, either prompt the user to pick entities OR auto-switch to `intent: discover`. Today there's no validation pass.

### 2. Meta-agent picks the wrong `signal_source` value

For "score new YC companies" the meta-agent emitted `signal_source: yc_directory`. The YC connector emits `signal_source: yc`. Result: the scorer never fires on real YC signals.

This is a known-string-mismatch problem. The meta-agent has examples, the connectors have examples, they don't match. Fix: have the parse endpoint pull the actual `signal_source` values produced by each connector and constrain the meta-agent to those.

### 3. Scorer produces generic fluff when no facts exist yet

Sample scorer outputs:

> "The Token Company fits your ideal customer profile. They're an early-stage, AI-forward startup improving LLM outputs with their compression middleware, addressing a clear need for efficiency in B2B." **cites: 0**

> "Talking Computers is an early-stage B2B company focused on optimizing AI infrastructure, fitting well with our ideal customer profile. Their innovative approach can significantly enhance training and inference processes." **cites: 0**

Both are corporate-template language ("fits your ideal customer profile," "innovative approach," "addressing a clear need"). Constitution says "no broad sweeping claims," "smart friend voice," "specific not generic." The LLM is ignoring it.

**Why cites=0:** the scorer fires *in parallel* with the enricher on the same signal. When the scorer runs, no enricher-extracted facts exist yet — so there's nothing to cite, and the LLM falls back to generic phrasing.

**Fix #1 (workflow ordering):** enricher should run BEFORE scorer/drafter on the same signal. Either:
- Sequence them: enricher fires on signal, asserts facts, emits a derived `enriched.signal` event that scorer/drafter subscribe to.
- OR enricher behavior includes "post a claim" as a side-effect.

**Fix #2 (constitution enforcement):** the constitution is in the prompt but the LLM clearly doesn't internalize it. Options: stronger negative phrasing, explicit forbidden-phrase list, or a deterministic post-process pass that flags violations and re-prompts. We already have an em-dash strip; expand to a "banned phrases" list (jargon detection).

### 4. Enricher extracts data already in entity.attributes

8 sample facts the enricher extracted from a YC signal:

```
The Token Company | yc_status   = "Active"           — already in attributes
The Token Company | yc_batch    = "Winter 2026"      — already in attributes
The Token Company | is_hiring   = "false"            — already in attributes
The Token Company | stage       = "Early"            — already in attributes
The Token Company | location    = "CA, USA"          — already in attributes
The Token Company | industry    = "B2B"              — already in attributes
```

Every "fact" duplicates an entity.attributes value. Net new ground truth = 0. The enricher is doing redundant work.

**Why:** the enricher's prompt sees the entity attributes AND the signal body, and re-extracts what's in attributes because the signal mentions them. It doesn't know what's already known.

**Fix:** include `existing facts AND existing entity attributes` in the enricher's prompt explicitly, and tell it "do not extract anything already present in either." That's a 2-line prompt change.

### 5. Drafter ignores the constitution

The one draft that actually wrote something (most went to gate, which is a separate problem):

```
Subject: Let's Level Up Your Engineering Team at Ventura

I noticed Ventura is hiring and actively building an AI workforce for distributors
and manufacturers. That's an exciting space with a lot of potential for automation
and efficiency.

As an early-stage company in the Industrials sector, your need for innovative
engineering talent aligns with what we see in other founding teams at your stage.
Founders like you are moving away from legacy systems and seeking solutions that
support modern workflows.

Are you open to a brief chat about how streamlining your operations could enhance
your hiring efforts?
```

Violations of the constitution:
- "Let's Level Up" — generic
- "exciting space with a lot of potential" — broad sweeping claim
- "your need for innovative engineering talent aligns with what we see in other founding teams" — corporate filler
- "Founders like you are moving away from legacy systems" — sweeping claim, no evidence
- "streamlining your operations could enhance your hiring efforts" — vague

**This is the email a recruiter would send. I would not send this.**

The constitution is being passed to the LLM but it's not being followed. Same fix as scorer: stronger negative phrasing + post-process detection of banned phrases.

Also: the drafter is talking to *Ventura* about *us*, but the email reads like it was generated for a job board scraping company. The framing of "what we sell" ↔ "what they need" is muddled. The About field is in the prompt but the LLM isn't using it sharply.

### 6. Drafters silently fail on deepseek-v4-flash

```
✗ yc_new_company 1a7b7ef8 → claims_yc_outbound_drafter → skip (LLM returned non-JSON: )
✗ yc_new_company ceae661d → claims_yc_outbound_drafter → skip (LLM returned non-JSON: )
```

Two of the drafter runs returned empty strings instead of JSON. ~10% failure rate on the deepseek-v4-flash model with `response_format: json_object`. OpenRouter sometimes returns empty completions when the model trips over JSON formatting.

**Fix:** retry on empty/malformed output, OR fall back to a different model. Don't just skip silently.

---

## What works well

### Provenance / citation chain (the architectural claim) — solid

Walked the chain on a real fact:

```
hop 0: event 451 (assert_fact) — actor=agent/claims_audit_yc_enricher
       prompt_hash=8f5262e49fb9d900...
       payload: {predicate: yc_status, object_text: Active, subject_entity: ...}

hop 1: event 343 (create_signal) — actor=agent/source:yc:c9793551
       payload: {type: yc_new_company, body: "The Token Company (YC Winter 2026..."}
```

Two hops, both fully resolved. The `cite()` primitive works as designed. Anyone receiving a draft can verify exactly where each claim came from.

### Discover-mode entity creation — solid

Ran the YC source: 10 new entities created, 10 signals tagged to them. Every entity has provenance back to the source.run event. Dedup-by-domain prevented duplicate creation when re-running.

### Concurrency / event-sourcing — solid

50 agent runs in ~30 seconds. No conflicts, no double-posts (idempotency check on parent_event_id worked). The append-only events table handled the burst with 0 errors.

---

## Defensibility

### What's hard to copy
- **Events as source of truth** — Salesforce/HubSpot can't retrofit this. The whole substrate would have to change.
- **Content-addressed facts** — re-asserting an identical fact is a no-op. Their CRMs would create dupes.
- **Replay** — `replay_to(timestamp)` reconstructs full state. They have nothing.
- **Concurrency without conflict** — append-only writes. They have last-write-wins.
- **Cite-or-die discipline** — every claim has a fact_id with a chain back. They have free-text notes.

These are categorical advantages, demonstrated in the benchmarks (BENCHMARK.md).

### What's easy to copy
- The agent loops themselves (claim_poster, drafter, enricher prompts)
- The connector list (HN, YC, GitHub are public APIs)
- The Sources/Agents UI shape
- The NL-driven config (anyone with an LLM can do this)

### The actual moat
The architectural advantages are real but **invisible to a prospect today**. A demo of agent-crm vs HubSpot's Breeze AI looks similar at first glance: both spit out claims and drafts.

The moat needs to be **surfaced and felt**:

1. **Cite popovers in /gates** — every claim in a draft links to its fact_id; click expands the chain. "I can prove every word in this draft is grounded." Today the UI just shows `cites: 6` as a count.

2. **Replay in one click** — anywhere you see a decision, "rerun against state at <date>" should be a button. Demonstrates the system can audit itself.

3. **Concurrency demo built-in** — `pnpm benchmark:concurrency` produces a number (96% data loss on HubSpot, 0% on us). Embed that in the marketing site as a live counter.

Without surfacing these, agent-crm looks like "another AI-on-top-of-CRM" play. With them, it looks like a different category.

### What an incumbent would do
HubSpot/Salesforce with 6 months of effort:
- Bolt their AI on top of existing tables: same as Rox/Breeze. Hits the same walls we're benchmarking against.
- Try to build an event log alongside their existing schema: schema migration of a 50-million-row production CRM. Politically and technically painful.
- Acquire someone who's already built an event-sourced CRM. **This is the most likely exit path for agent-crm.**

The 6-month head start matters. Each month we run live, produce real customer data, refine prompts, and ship cite-chain UI is a month they can't compress.

---

## Top 5 fixes by impact

1. **Workflow ordering: enricher → scorer/drafter** — scorer can cite real facts. Single biggest quality gain.
2. **Surface cite chains in /gates UI** — turns the architectural moat into something a buyer can feel.
3. **Constitution enforcement: banned-phrase post-process** — drafts stop reading like AI templates.
4. **Source-validation pass on parse** — sources don't fail silently on first run.
5. **Enricher: skip facts already in attributes/active facts** — stop wasting tokens on redundant extractions.

Each is < 1 hour of focused work.

---

## Top 3 next moves (multi-day)

1. **Migrate the 4 source-specific connectors to presets backed by `api_call`** — turns "adding a new source" from a code change into a row insert. Real scalability.
2. **One-click replay UI** — drag a slider, see the state, rerun any decision. Demoable in 30 seconds. The single most defensible feature to surface.
3. **Real ingest data flowing 24/7** — set up Inngest cloud + deploy to Vercel, run for a week, capture actual outbound results. The dog-food validates everything else.

---

## Honest assessment

If I had to bet money on whether agent-crm could replace HubSpot for a real GTM team today:

- For a 1-person solo founder doing outbound: **no, not yet.** Drafts aren't sendable, scorer is generic, sources fail silently. They'd hit a wall in week 1.
- For an engineering-heavy team that wants to script their own agents: **yes, with caveats.** The substrate is solid, the API is sane, they could build their own UI on top.
- For Jake's specific dog-food (selling agent-crm to YC founders): **close, but the drafts need to be sendable first.** The voice problem is the gating issue.

The architectural pitch is real. The polish gap is large but tractable. 4-5 days of focused prompt + UX work and this clears the bar for a credible alpha.

The 6 specific findings above are exactly that work.
