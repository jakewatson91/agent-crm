# agent-crm vs HubSpot — Benchmark Results

Last run: 2026-05-09. Both runners reproducible via the scripts in `benchmark/runners/`. Raw metrics in `benchmark/metrics/`.

## Summary so far

| # | Workload | agent-crm | HubSpot | Result |
|---|---|---|---|---|
| 1 | Token cost per autonomous decision | 532 input tokens | 680 input tokens | **1.28×** win on tokens |
| 3 | Concurrency without conflict (50 parallel writers, same account) | 50 / 50 facts persisted (0% loss) | 2 / 50 facts persisted (**96% loss**) | **Categorical** — HubSpot silently loses 48 of 50 writes |
| 5 | Provenance recovery (walk fact → source event → actor → prompt_hash) | 2-hop chain recovered, every hop carries actor + action + payload | 0 hops past the prose blob | **Categorical** — HubSpot has no event log, no actor identity per write, no prompt_hash |
| 6 | Replayability (full state at past timestamp) | `replay_to(ts)` — one RPC, deterministic, full snapshot | No snapshot endpoint; propertiesWithHistory is per-property only with no time filter and no actor/action/prompt | **Categorical** — HubSpot can't rerun agent reasoning against past state |

The token-cost win is real but small. The other three results are the dramatic ones and the right shape of the architectural pitch: the load-bearing properties of agent-crm aren't "faster" — they're "things HubSpot can't do at all without paying real correctness costs."

Workloads 2 and 4 still pending.

---

## Workload 1: Token cost per autonomous decision

**Scenario:** A new signal arrives for an account. The agent must decide whether to send an outbound touch this week and produce a structured decision (`{decide, reasoning, citations}`).

**Workload spec:** [`benchmark/workloads/token_cost.yaml`](benchmark/workloads/token_cost.yaml)

**Both sides use:** `gpt-4o-mini` via OpenAI Chat Completions API. 6 accounts × 3 runs = 18 runs per system. Token counts come from OpenAI's authoritative `usage.prompt_tokens` (no estimation).

### Results

| Metric | agent-crm | HubSpot | Ratio |
|---|---:|---:|---:|
| Avg input tokens | 532.3 | 679.8 | **1.28×** |
| Avg output tokens | 159.1 | 169.4 | 1.06× |
| Avg latency (ms) | 3942 | 4146 | 1.05× |
| LLM turns per decision | 1 | 2 | 2× |
| Data-store API calls per decision | 3 (Supabase) | 1 (HubSpot) | n/a |

Per-account input-token ratios are tight: 1.22× – 1.37×. Result is consistent, not a single-account artifact.

### Method

**agent-crm side:** A single shaped projection (entity + facts + signals + IDs) is loaded via 3 Supabase reads, then handed to the LLM as compact structured JSON. One LLM call.

**HubSpot side:** Agent has a single tool `hubspot_get_company_by_name`. The tool wrapper requests only the 6 fields we care about (`name`, `domain`, `description`, `stack`, `agent_facts`, `agent_signals`) and **strips HubSpot's envelope wrapper** (`createdAt`, `updatedAt`, `archived`, `url`) before passing to the LLM. Two LLM turns: turn 1 chooses the tool, turn 2 receives the result and decides.

This is the *strongest reasonable* HubSpot baseline. We deliberately:
- Used a one-shot fetch tool rather than paginated note discovery
- Stored facts and signals as structured custom properties on the company
- Stripped HubSpot's wrapper metadata in the tool wrapper (~80 tokens saved per turn)
- Embedded `fact_id=...` into the property text so HubSpot can produce real citations rather than hallucinated strings

A naive HubSpot baseline (paginated notes, separate engagement fetches, no envelope stripping, no embedded ids) inflates the ratio significantly. **The 1.28× number is the floor on HubSpot's overhead, not the ceiling.**

### Where the win comes from

1. **JSON vs prose.** agent-crm's projection is structured JSON the model parses directly; HubSpot returns prose-shaped property text the model still has to read.
2. **Two turns vs one.** Tool-use loops re-send the system prompt + prior tool-call payloads on every turn. A single-turn projection avoids that entirely.

### What this metric does *not* measure

Token efficiency is the easiest comparison but not where the architectural wedge lives. The actual differentiators — provenance chains, replayability, concurrency safety — are capability differences, not perf wins. Token cost is the warm-up.

---

## Workload 3: Concurrency without conflict

**Scenario:** Multiple specialized agents (intent scorer, enricher, hiring-signal watcher, github-watcher, etc.) write to the same account's profile during a signal burst. How many distinct writes survive?

**Workload spec:** [`benchmark/workloads/concurrency.yaml`](benchmark/workloads/concurrency.yaml)

### Results

| Metric | agent-crm | HubSpot |
|---|---:|---:|
| Concurrent writers | 50 | 50 |
| Facts attempted | 50 | 50 |
| Facts persisted | **50** | **2** |
| Data loss count | 0 | 48 |
| Data loss % | **0%** | **96%** |
| Wall clock (50 parallel) | 1306 ms | 1628 ms |
| HTTP/RPC errors returned | 0 | 0 (!) |

**HubSpot returned HTTP 200 on every single PATCH and silently lost 48 of 50 distinct facts.** That is the most important number on this page. There is no error to retry on. The integration *thinks* it succeeded.

### Method

**agent-crm side:** 50 parallel `assert_fact()` calls via the `record_event` RPC, each writing a unique `(predicate, object_text)` pair. Append-only events, content-hashed facts, no read-modify-write anywhere in the path.

**HubSpot side:** 50 parallel writers each performing the realistic pattern for adding a fact to a HubSpot company:
1. `GET /crm/v3/objects/companies/{id}` → read current `agent_facts` text
2. Append a new line: `[concurrency_test_<run_tag>_<i>] writer_<i> test_value`
3. `PATCH /crm/v3/objects/companies/{id}` → write merged `agent_facts`

This is the only reasonable pattern. HubSpot has no append-only fact store. Custom objects would have the same problem. The text property is *the* place facts live in HubSpot when notes/engagements aren't accessible.

After the burst, we read `agent_facts` back and count distinct `[concurrency_test_<run_tag>_<i>]` markers. 2 survived. 48 silently overwrote each other.

### Why this matters more than tokens

Anyone building agentic outbound on HubSpot today will hit this in production the moment two agents touch the same account simultaneously. The correctness cost is invisible: PATCH says success, the data is gone.

agent-crm doesn't beat this by being faster. It beats it by **not having the problem at all.** Every write is an event. Events compose by appending. Reads are projections. Last-write-wins has no place in the data path.

You cannot benchmark this as "5× better" — it's a categorical capability gap.

---

## Workload 5: Provenance recovery

**Scenario:** A decision agent cited `fact_id=e856db03-...` ("Resona uses_stack=bun"). Walk the chain back: where did this fact come from, who wrote it, and what's the verifiable history?

**Workload spec:** none — this is a capability demo, not a ratio.

### Results

| Hop | agent-crm | HubSpot |
|---|---|---|
| 0 | bun fact (id, content_hash, observed_at) → event 159 → actor `agent/claims_account_facts` → action `supersede_fact` → payload | "[uses_stack] bun (...fact_id=e856db03-...)" inside `agent_facts` text blob |
| 1 | python fact (id, content_hash, observed_at) → event 138 → actor `agent/claims_account_facts` → action `assert_fact` → payload | — no further chain — |
| 2+ | (chain ends because seed had only one supersede) | — no further chain — |

**Recoverable chain depth:**
- agent-crm: 2 hops, each via one SQL query. Every hop has actor identity, action verb, payload, and a slot for `prompt_hash` (null in seed but populated when the fact was generated by an agent run).
- HubSpot: 0 hops past the prose blob. The `fact_id=...` string in `agent_facts` is opaque to HubSpot; it lives in the agent-crm Supabase. HubSpot has no fact table to look it up in. `propertiesWithHistory` returns past property values but no actor identity, no action verb, no prompt_hash, no causal parent.

### What this means in practice

When an agent says "I decided X because of fact Y," you need to verify Y exists, was asserted by a trusted actor, and trace the prompt that produced it. agent-crm gives you that in one join. HubSpot gives you the prose the model is citing — which the model could have invented.

This is exactly the gap that bites in audit, debugging, and compliance. It's also what enables advanced patterns like "pin this agent to a knowledge snapshot" — impossible without a content-addressed event log.

---

## Workload 6: Replayability

**Scenario:** Reconstruct the full state of an account at a past timestamp. Test case: at T1 we had Resona with `uses_stack=python`; at T2 we superseded that with `uses_stack=bun`. Replay state at T1 should show python; at T2 should show bun.

**Workload spec:** none — capability demo.

### Results

**agent-crm:** `replay_to(workspace_id, ts)` is a single Postgres RPC that filters events to `created_at <= ts` and re-projects state. Output is deterministic JSON.

| Replay timestamp | uses_stack facts on Resona |
|---|---|
| T_before (just before the supersede event) | typescript, postgres, **python** |
| T_after (now) | typescript, postgres, **bun** |
| Determinism (same call twice) | identical results ✓ |

**HubSpot:** no equivalent primitive.

| Attempt | Result |
|---|---|
| `GET /crm/v3/objects/companies/{id}/snapshot?at=<ts>` | 404 — no such endpoint |
| `propertiesWithHistory=<all>` | Per-property version list. No time filter. Each version has `(value, timestamp, sourceType, sourceId)`. No actor identity, no prompt_hash, no action verb, no causal parent. |

To approximate replay on HubSpot you would have to: fetch propertiesWithHistory per object per field, for each find the version whose `timestamp <= T`, stitch values into a synthetic envelope, repeat across every related object. Even then you cannot rerun the agent against the past state because there's no prompt_hash or actor identity per write — the data structure has lost the agent reasoning it needs to be replayable.

agent-crm: 1 RPC. HubSpot: nontrivial reconstruction effort that still can't rerun agent reasoning.

---

## Outstanding workloads

Not yet run:

2. **Latency per autonomous decision** — currently tied (~4s both sides), dominated by LLM call time, not data layer. Architectural advantage doesn't show until the agent runtime warms (Inngest path).
4. **Subscription matching throughput** — 10k signals × 1k subscriptions in single SQL on agent-crm. HubSpot has no comparable primitive (workflows are coarse triggers, not vector matches).

## Reproducing

```bash
pnpm seed                                     # populate agent-crm with demo data
pnpm exec tsx benchmark/runners/hubspot/mirror_seed.ts   # mirror to HubSpot

# Workload 1
pnpm exec tsx benchmark/runners/agent-crm/run.ts
pnpm exec tsx benchmark/runners/hubspot/run.ts
pnpm exec tsx benchmark/report/generate.ts

# Workload 3
pnpm exec tsx benchmark/runners/agent-crm/concurrency.ts
pnpm exec tsx benchmark/runners/hubspot/concurrency.ts

# Workloads 5 & 6 (capability demos)
pnpm exec tsx benchmark/runners/agent-crm/provenance.ts
pnpm exec tsx benchmark/runners/hubspot/provenance.ts
pnpm exec tsx benchmark/runners/agent-crm/replay.ts
pnpm exec tsx benchmark/runners/hubspot/replay.ts
```

Raw metrics: `benchmark/metrics/{token_cost,concurrency,provenance,replay}_{agent-crm,hubspot}.json`.
