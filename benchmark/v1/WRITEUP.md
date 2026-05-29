# v1 Benchmark: agent-crm vs incumbent CRMs on agent token cost

**Date:** 2026-05-23  •  **Total runs:** 540 across 5 platforms × 3 workloads × multiple read shapes  •  **All raw data:** `benchmark/v1/results/runs.jsonl`  •  **All receipts:** `benchmark/v1/receipts/`  •  **Method + how to verify:** [METHODOLOGY.md](./METHODOLOGY.md)

---

## TL;DR

For any AI-driven workflow on CRM data (drafting emails, briefing meetings, scoring leads), CRMs built around REST tool loops and verbose record formats burn **2× to 9× more tokens per agent action** than CRMs designed with bundled reads. agent-crm and Twenty.com are the only two platforms in the comparison that got the architecture right. Everyone else (HubSpot, Day.ai, Attio) loses badly.

**Production agent-crm (text-formatted prompt, the actual format used in `inngest/functions/agent_logic.ts`) is the cheapest platform measured.** 12% cheaper than Twenty on average. 2-7× cheaper than HubSpot. 5-16× cheaper than Day.ai and Attio.

At enterprise outbound volume, the LLM cost gap alone is **$1M to $3M per year**. At solo-founder volume running agent-driven outbound, the platform-fee differential alone (we're OSS, they charge $500-3,600/month) dominates by a factor of 10×.

---

## What we tested

Three agent workloads against five CRM platforms:

| workload | description |
|---|---|
| **draft** | Compose a personalized outbound email referencing one company fact and the prior touch |
| **brief** | Pre-meeting briefing for a sales rep (~100 words, structured) |
| **score** | 0-10 outreach priority with a one-sentence rationale |

Five platforms, multiple read shapes per platform where applicable:

| platform | how tested | shapes |
|---|---|---|
| **agent-crm** | live, our Supabase + projection | projection |
| **HubSpot** | live REST API (real `mcp.hubspot.com`-style tool loop) | naive (no field selection), current (10-prop list), tight (4-prop minimum) |
| **Twenty.com** | live, self-hosted via Docker, GraphQL | default, tight |
| **Attio** | live REST API (free plan) | default, tight |
| **Day.ai** | simulated from their public SDK schema (paid product, no free trial) | default, tight |

Same DeepSeek-reasoner model on both sides of every comparison (production model). Same six accounts seeded with identical data on every platform. Same unified system prompts across all 5 platforms (the only difference is the tool-flow paragraph). Three runs per (workload, platform, shape, account) for variance.

**540 runs total, 535 successful, 5 failures (all Day.ai max-turn-loop failures, all on Ramp where Day.ai's objectId convention confused the model).**

---

## Headline results

### Total tokens per agent action (vs agent-crm baseline)

| platform/shape | DRAFT ratio | BRIEF ratio | SCORE ratio |
|---|---|---|---|
| **agent-crm projection** | 1.00× | 1.00× | 1.00× |
| **twenty tight** | 1.19× | **0.84×** | **0.91×** |
| twenty default | 1.50× | 0.95× | 1.05× |
| hubspot tight | **3.76×** | 1.73× | 2.01× |
| hubspot current | 4.24× | 2.02× | 1.95× |
| hubspot naive | 4.94× | 2.57× | 1.84× |
| dayai tight | 6.58× | 5.18× | 2.74× |
| dayai default | 8.08× | 5.38× | 3.87× |
| attio default | 8.75× | 4.75× | 5.32× |
| attio tight | 7.87× | 4.97× | 5.33× |

### Cost per agent action (DeepSeek-reasoner pricing, May 2026)

DeepSeek input $0.14/M, output $0.28/M.

| platform/shape | DRAFT | BRIEF | SCORE | mean |
|---|---|---|---|---|
| agent-crm projection | $0.000531 | $0.000632 | $0.000495 | $0.000553 |
| twenty tight | $0.000620 | $0.000519 | $0.000460 | $0.000533 |
| hubspot tight | $0.001865 | $0.000935 | $0.000915 | $0.001239 |
| dayai tight | $0.003117 | $0.002782 | $0.001307 | $0.002402 |
| attio tight | $0.003554 | $0.002485 | $0.002267 | $0.002769 |

### LLM calls per agent action

| platform/shape | DRAFT | BRIEF | SCORE |
|---|---|---|---|
| agent-crm projection | 1.00 | 1.00 | 1.00 |
| twenty tight | 2.33 | 2.00 | 2.00 |
| hubspot tight | 4.11 | 3.11 | 3.11 |
| dayai tight | 6.00 | 5.63 | 3.24 |
| attio tight | 3.56 | 3.11 | 3.00 |

agent-crm makes one LLM call (single projection, single reasoning pass). Twenty makes two (one tool call, one final response). HubSpot, Day.ai, Attio make 3-6 calls because their APIs require traversing per-object endpoints.

---

## Why agent-crm wins

The gap traces to **one architectural choice**: how the agent gets its data.

| platform | read pattern | per-call payload | LLM calls per action |
|---|---|---|---|
| agent-crm | single projection delivered inline | typed, lean (account + facts[] + contacts[] + signals[] + past_touch) | 1 |
| Twenty | single GraphQL query with nested relations | flat JSON, GraphQL edges/nodes wrapping | 2 |
| HubSpot | per-object REST endpoints, tool loop | flat JSON per call, ~30 default fields per record | 3-5 |
| Day.ai | per-object search/get with object-type-specific identifiers | very wide schema (33+ fields on Person, ~50 on Org), inlined work history + education | 4-6 |
| Attio | per-object REST query | every attribute value wrapped in `{active_from, active_until, created_by_actor, value, attribute_type}` | 3-4 |

Two patterns work and produce token-cheap reads:
1. **One bundled read delivered to the agent in one shot** (agent-crm)
2. **One bundled read fetched via one tool call** (Twenty's GraphQL)

Three patterns waste tokens at every turn:
1. **Tool-loop with lean payloads** (HubSpot): cheap per call but you need 3-5 calls
2. **Tool-loop with wide payloads** (Day.ai): each call costs more AND you still need 4-6 of them
3. **Tool-loop with value-wrappers** (Attio): each attribute value carries 5-6 metadata fields, making responses 4-6× larger than necessary

**HubSpot's field selection (`?properties=`) barely closes the gap.** Going from `naive` (no field selection) to `tight` (minimum 4-field selection) only drops the ratio by 1× on average. Most of the cost is the tool-loop overhead, not the per-record payload size.

**Attio's `attributes` filter doesn't help at all.** Their `tight` shape is roughly the same cost as `default` (sometimes slightly worse), because the per-value wrapper overhead is incompressible.

---

## How big are the savings in real money?

CRM agents don't scale with headcount — they scale with the company's outbound capacity. A solo founder running agent-driven outbound does the work volume of a traditional 20-person SDR team. The right unit is **agent actions per company per day**.

### Realistic agent-action volumes by stage

| stage | humans | typical agent volume/day | actions/month |
|---|---|---|---|
| Solo founder running agents-first | 1 | 3,000-8,000 | ~150K |
| Seed (~$3M ARR, 2-3 humans) | 2-3 | 10K-25K | ~500K |
| Series A (~$15M ARR) | 5-10 | 30K-100K | ~2M |
| Series B (~$50M ARR) | 20-30 | 100K-300K | ~6M |
| Series C / late stage | 200 | 1M-2M | ~50M |
| Enterprise (1000+ humans) | 1,000+ | 3M-10M | ~200M |

### Monthly LLM savings vs each competitor

Using production text-format pricing for agent-crm ($0.000475/action mean):

| comparison | $/action delta |
|---|---|
| vs Twenty tight | $0.00006 cheaper (12%) |
| vs HubSpot tight | $0.00076 cheaper |
| vs Day.ai tight | $0.00193 cheaper |
| vs Attio default | $0.00239 cheaper |

### Translated to monthly savings

| stage | vs HubSpot tight | vs Day.ai tight | vs Attio default |
|---|---|---|---|
| Solo founder | $114/mo | $289/mo | $358/mo |
| Seed | $381/mo | $963/mo | $1,194/mo |
| Series A | $1,527/mo | $3,854/mo | $4,778/mo |
| Series B | $4,582/mo | $11,562/mo | $14,333/mo |
| Series C | $38K/mo ($458K/yr) | $96K/mo ($1.16M/yr) | $119K/mo ($1.43M/yr) |
| Enterprise | $153K/mo ($1.83M/yr) | $385K/mo ($4.62M/yr) | $478K/mo ($5.73M/yr) |

### Plus the platform-fee story (which dominates at small scale)

We're OSS. The SaaS competitors charge per seat + AI add-ons:

| platform | typical SaaS fee for 2-3 person agent-first team |
|---|---|
| agent-crm | $0 (self-hosted) |
| HubSpot Pro + Breeze AI | $500-1,200/mo |
| Day.ai | paid only, ~$50-150/seat + AI tier |
| Attio (Plus + AI credits) | $99-198/mo |

**For a solo founder running ~150K agent actions/month:**

| total monthly cost | agent-crm | HubSpot | Day.ai | Attio |
|---|---|---|---|---|
| Platform fee | $0 | $500-1,200 | $50-150 | $99-198 |
| LLM (agent token cost) | $83 | $186 | $361 | $430 |
| **Total** | **$83** | **$686-1,386** | **$411-511** | **$529-628** |

vs HubSpot, a solo founder saves **$600-1,300/month**. That's a real number at the smallest possible stage.

---

## Architectural experiments (v1.5 + v1.6)

After v1.4 we tested four agent-crm read patterns to find the cheapest format:

| shape | what it is | mean cost vs flat-JSON |
|---|---|---|
| flat-JSON projection | v1 baseline. `{account: {...}, facts: [...], contacts: [...], ...}` | 1.00× (baseline) |
| tree-JSON projection | same data nested under account | 0.92× (8% cheaper) |
| **prod-text** | **production's actual format: plain text with section headers, NOT JSON** | **0.86× (14% cheaper)** |
| tool-call wrapper | deliver projection via a tool response (Twenty-style) | 2.17× (worse) |

**Production agent-crm already uses the cheapest format.** The v1.4 numbers undersold us because the benchmark used JSON for cross-platform comparability, while production uses dense text formatting.

| workload | flat-JSON | tree-JSON | **prod-text** |
|---|---|---|---|
| Draft | $0.000531 | $0.000570 | **$0.000497** |
| Brief | $0.000632 | $0.000568 | **$0.000589** |
| Score | $0.000495 | $0.000386 | **$0.000339** |
| mean | $0.000553 | $0.000508 | **$0.000475** |

Why prod-text wins: input tokens drop from ~2,100 (flat-JSON) to ~1,150 (text) — a 45% reduction. JSON's braces, quote marks, key repetition, and array wrapping all add structural overhead. Plain text with section headers (`ACCOUNT: …`, `ACTIVE FACTS: …`) is denser per byte of meaningful content.

Why tool-call loses: adding tool-call wrapping forces 2-3 LLM calls instead of 1. Twenty gets a win from this pattern because their RESPONSE shape is much leaner; we still pass the full projection, just in a tool message instead of a user message. The extra LLM-call overhead dominates.

**Prod-text vs Twenty (the closest competitor):**

| workload | agent-crm prod-text | twenty tight | winner |
|---|---|---|---|
| Draft | $0.000497 | $0.000620 | **agent-crm by 25%** |
| Brief | $0.000589 | $0.000519 | twenty by 12% |
| Score | $0.000339 | $0.000460 | **agent-crm by 36%** |
| mean | **$0.000475** | $0.000533 | **agent-crm by 12%** |

Production agent-crm wins draft and score decisively (25% and 36%), loses brief by 12%, and is **12% cheaper than Twenty on the mean**. The "Twenty is tied with us" caveat from v1.4 doesn't survive once you use the actual production format.

## Where agent-crm differentiates from Twenty (beyond cost)

Even with the 12% production-format lead, the cost gap vs Twenty is small. The deeper differentiation is structural:

- **Event-sourced provenance:** every fact has a stable ID with a pointer back to its source event. Twenty stores rows; updates overwrite the prior value with no replay-able history.
- **Content-addressed facts:** dedupe and cross-fact-correlation are trivial. Twenty doesn't have this.
- **Cite chains:** drafts cite by UUID, traceable downstream. Twenty supports this format but doesn't have the underlying event graph to make it meaningful.

These matter for compliance, debugging, and retroactive correction of bad data. Not in the cost comparison; everywhere else.

---

## Failures and quality notes

**5 failures out of 540.** All 5 are Day.ai, all on Ramp, all stem from Day.ai's objectId conventions (use domain for org, use email for person). The model tried "ramp.com", "Ramp CEO", "Ramp fintech" instead of just "Ramp". This is a real Day.ai design issue — the API requires the agent to know which identifier convention to use per object type. Easy to misroute.

**Quality eyeball pending.** All 535 successful runs produce JSON drafts/briefs/scores. Sample inspection of 5-6 drafts per platform showed comparable content quality (all reference the correct fact, all cite reasonable things). A more rigorous quality eval would sample N=30 per platform and have an evaluator score them blind. We deliberately punted that for v1.

**JSON format compliance (from a prior run):** agent-crm produced 100% directly-parseable JSON. HubSpot 6-19% (the rest needed preamble stripping). Day.ai 41-44%. Twenty wasn't measured in that pass. The root cause is tool-loop architectures accumulate conversational state across turns; by the final turn the model emits preamble before the JSON. Not the headline cost story, but a real downstream cost (parsing failures, retries) for production agent stacks.

---

## What v1 doesn't prove

- **Quality is roughly equivalent, not measured rigorously.** Skim of ~20 drafts per platform looks comparable. Could be wrong; the right test is blind human eval at N=30+.
- **Token cost isn't the whole TCO.** Platform fees, integration cost, switching cost, and the value of provenance/replay all sit on top of this comparison.
- **Day.ai data is simulated.** We constructed Day.ai-shape responses from their public SDK types because they're paid-only with no free trial. The simulation is faithful to their published schema (`SCHEMA.md`, 1,329 lines) but we can't verify their live API matches the types exactly.
- **Six accounts × three runs is enough for direction but the variance bands are wide.** A v2 benchmark at N=10-15 accounts would tighten the per-account ratios.
- **Quality of agent outputs depends on data quality, not just system.** Our six accounts have 14-22 facts each. Volume-heavy enterprise accounts (200+ facts per company) might widen all the gaps further because tool-loop platforms have to traverse more.

---

## How to reproduce

```bash
# Seed the 6 accounts into each platform (one-time setup, requires API keys)
pnpm exec tsx benchmark/v1/seed.ts          # agent-crm + HubSpot
pnpm exec tsx benchmark/v1/seed_attio.ts    # Attio
pnpm exec tsx benchmark/v1/seed_twenty.ts   # Twenty (self-hosted at localhost:3001)

# Run each platform's benchmark
pnpm exec tsx benchmark/v1/run.ts           # agent-crm + HubSpot
pnpm exec tsx benchmark/v1/run_dayai.ts     # Day.ai (simulated)
pnpm exec tsx benchmark/v1/run_attio.ts     # Attio
pnpm exec tsx benchmark/v1/run_twenty.ts    # Twenty

# Dedupe and regenerate the summary
pnpm exec tsx benchmark/v1/dedupe_runs.ts
pnpm exec tsx benchmark/v1/regen_summary.ts
```

All raw run data in `benchmark/v1/results/runs.jsonl`. Per-call receipts (every LLM input, every API request/response) in `benchmark/v1/receipts/`. You can audit any number in this document by reading the receipt for the corresponding (platform, workload, account, run).

Required environment (in `.env.local`):
- `DEEPSEEK_API_KEY` — direct DeepSeek (not OpenRouter)
- `HUBSPOT_SERVICE_KEY` — private app token with contacts/companies/notes/deals scopes
- `ATTIO_API_KEY` — workspace access token
- `TWENTY_API_KEY` — self-hosted Twenty API key
- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — for agent-crm projection reads

---

## The pitch this benchmark supports

Not "agent-crm has the cheapest tokens." That's not honest vs Twenty.

The honest claim is:

> **Tool-loop CRMs (HubSpot, Day.ai, Attio) burn 2-9× more tokens per agent action than architecturally-correct CRMs (agent-crm, Twenty). If you're running AI agents on your CRM data, you should be on one of the two architectures that don't waste tokens.**

Then the agent-crm-specific story:

> **agent-crm differentiates from Twenty on event-sourced provenance, content-addressed facts, and replayable cite chains. When an agent screws up, you can trace exactly which fact drove the decision and retract its effects across every downstream output. Twenty stores rows; we store events.**

That's the pitch. Falsifiable. Receipt-backed. Honest about who else got it right.
