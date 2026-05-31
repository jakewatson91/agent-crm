> **SUPERSEDED (v0, archived 2026-05-28).** These figures, including the headline `4.22x` drafter number, were measured on gpt-4o-mini against partly-stubbed HubSpot data on a single workload. They do not reflect current results and should not be cited. The live source of truth is `benchmark/v1/WRITEUP.md` (5 real platforms, real APIs, the same model on every side, receipts committed). Verify the current numbers with `pnpm benchmark:v1:audit`. Kept here only for history.

# agent-crm vs HubSpot — Benchmark Results

Last run: 2026-05-17. Both runners reproducible via the scripts in `benchmark/runners/`. Raw metrics in `benchmark/metrics/`.

## Summary

| # | Workload | agent-crm | HubSpot | Result |
|---|---|---|---|---|
| 1a | Single decision (toy workload) | 1,225 input tokens | 1,082 input tokens (floor) / 1,224 (default setup) | **Tied / inverted on current data.** Don't cite. |
| **1b** | **Realistic drafter (real workflow)** | **1,084 input tokens, 1 LLM call** | **4,575 input tokens, 3.94 LLM calls** | **4.22× cheaper tokens, 3.94× fewer LLM calls, 1.41× lower latency** |
| 3 | Concurrency without conflict (50 parallel writers, same account) | 50 / 50 facts persisted (0% loss) | 2 / 50 facts persisted (**96% loss**) | **Categorical** — HubSpot silently loses 48 of 50 writes |
| 5 | Provenance recovery (walk fact → source event → actor → prompt_hash) | 2-hop chain recovered, every hop carries actor + action + payload | 0 hops past the prose blob | **Categorical** — HubSpot has no event log, no actor identity per write, no prompt_hash |
| 6 | Replayability (full state at past timestamp) | `replay_to(ts)` — one RPC, deterministic, full snapshot | No snapshot endpoint; propertiesWithHistory is per-property only with no time filter and no actor/action/prompt | **Categorical** — HubSpot can't rerun agent reasoning against past state |

**The headline number is Workload 1b: 4.22× cheaper per realistic drafter task.** Workloads 3, 5, 6 remain categorical capability gaps. Workload 1a (the original 1.28× single-decision claim) is dead — kept here transparently for context but should not be cited.

Workloads 2 and 4 still pending.

---

## Workload 1a: Single-decision token cost (DEPRECATED — DO NOT CITE)

The original benchmark in this file claimed 1.28× input-token win on a "decide yes/no" task. **That number no longer holds**, for three reasons discovered during re-validation:

1. **Numbers don't survive data growth.** Re-running on current data: agent-crm at 1,225 input tokens, HubSpot floor at 1,082, HubSpot default-setup at 1,224. On 5 of 6 accounts HubSpot was cheaper. The original snapshot was point-in-time and broke as the facts table accumulated.

2. **Bug in the agent-crm runner.** `benchmark/runners/agent-crm/run.ts:76` filtered facts with `.is('supersedes', null)`, which returns ORIGINAL facts and excludes the LATEST in any supersede chain. When `uses_stack=python` was superseded by `uses_stack=bun`, the runner showed the agent the stale `python` fact. **Fixed** in this session to match `mirror_seed.ts` logic.

3. **Single-tool workloads measure format choice, not architecture.** HubSpot's flat-text-in-a-textarea vs agent-crm's structured JSON is a serialization choice both systems can make. If HubSpot serialized JSON in their textarea, the gap vanishes.

**Don't pitch the 1.28× number.** It was a snapshot that didn't survive growth, and the test it measured isn't the work the agent actually does.

---

## Workload 1b: Realistic drafter cost (USE THIS)

**Scenario:** *"Draft a personalized follow-up email to the best contact at this account, referencing one specific fact about the company AND the prior touch."*

This is what the agent actually does in production. It requires the agent to know about the company, who to email, what was said last time, and recent context. **This is the right benchmark to cite.**

**Workload spec:** to be added at `benchmark/workloads/realistic_drafter.yaml`. Runners live at `benchmark/runners/{agent-crm,hubspot}/run_drafter.ts`. Detailed report at `benchmark/report/drafter_cost.md`.

**Both sides:** `gpt-4o-mini` via OpenAI Chat Completions API. 6 accounts × 3 runs = 18 runs per system.

### Results

| Metric | agent-crm | HubSpot | Ratio |
|---|---:|---:|---:|
| Avg input tokens | 1,084 | 4,575 | **4.22×** |
| Avg output tokens | 126 | 173 | 1.37× |
| Avg latency (ms) | 3,757 | 5,312 | 1.41× |
| LLM calls per task | **1.00** | **3.94** | 3.94× |

### Per-account input tokens

| Account | agent-crm | HubSpot | Ratio |
|---|---:|---:|---:|
| Resona Labs | 1,063 | 10,763 | **10.13×** |
| Forge Robotics | 1,155 | 3,445 | 2.98× |
| Plaintext.so | 1,250 | 3,300 | 2.64× |
| Halo Health | 1,064 | 3,457 | 3.25× |
| Brightvine | 981 | 3,239 | 3.30× |
| Strand Compute | 990 | 3,248 | 3.28× |

Resona is the high end (its accumulated `agent_facts` blob in HubSpot is ~5,400 chars and gets re-sent every LLM turn). The other 5 accounts cluster at 2.6-3.3×. **3× is the floor; 4× is the average; 10× is the worst case for a fact-rich account.**

### Method

**agent-crm side:** one Supabase round-trip pulling entity + facts + contacts + past_touch + signals as a unified projection. One LLM call producing JSON draft.

**HubSpot side:** a real `hubspot_get_company_by_name` API call (default property set, no envelope stripping), then two stubbed tool calls — `hubspot_get_associated_contacts` and `hubspot_get_recent_notes` — using documented HubSpot v3 response shapes. Our service key lacks contacts/engagements scope, but a real customer would have both. Content matches the agent-crm seed verbatim. The HubSpot loop is 4 LLM turns: call company → call contacts → call notes → emit draft.

### Why the gap

In HubSpot, companies, contacts, and engagements live in three separate tables traversed via associations. The drafter MUST call three tools to write a personalized email referencing facts, the right contact, and the prior touch. Each tool turn re-sends the system prompt + user message + every prior tool call + every prior tool result. A 4-turn loop pays for the context four times.

agent-crm projects that traversal into one read at query time and gets it in 1 turn.

**This is structural, not a format choice.** HubSpot cannot reformat their way out of it — the multi-call requirement is intrinsic to how their data model splits entities across tables.

### Dollar cost

At gpt-4o-mini ($0.15 / 1M input, $0.60 / 1M output):

| Workload | agent-crm | HubSpot | Difference |
|---|---:|---:|---:|
| 500 drafts/week | $0.12 / wk ($6 / yr) | $0.40 / wk ($21 / yr) | 3.3× |
| 5,000 drafts/week | $1.20 / wk ($62 / yr) | $4.00 / wk ($205 / yr) | 3.3× |

At gpt-4o ($2.50 / 1M input, $10 / 1M output):

| Workload | agent-crm | HubSpot | Difference |
|---|---:|---:|---:|
| 5,000 drafts/week | $19.80 / wk ($1,030 / yr) | $65.80 / wk ($3,420 / yr) | 3.3× |

At Claude Sonnet 4.6 ($3 / 1M input, $15 / 1M output):

| Workload | agent-crm | HubSpot | Difference |
|---|---:|---:|---:|
| 5,000 drafts/week | $25.70 / wk ($1,335 / yr) | $81.60 / wk ($4,243 / yr) | 3.2× |

Per-decision the dollar gap is small. At scale and on stronger models it's material. The gap widens as workflow complexity grows — every additional context the drafter needs (deals, recent emails, support tickets) is another HubSpot tool turn that re-bills the entire context.

### Single-account verification (`scripts/demo_drafter_walkthrough.ts`)

Live trace of Forge Robotics through both pipelines. Run with:

```bash
DOTENV_CONFIG_PATH=.env.local pnpm exec tsx scripts/demo_drafter_walkthrough.ts "Forge Robotics"
```

Confirms aggregate numbers aren't a math artifact. HubSpot turn-by-turn cumulative input shows the multi-turn tax in action:

```
Turn 1: 237 tokens   (system + user)
Turn 2: 708 tokens   (+company response)
Turn 3: 999 tokens   (+contacts response)
Turn 4: 1,173 tokens (+notes response → draft)
Total: 3,117 input tokens for 4 LLM calls
```

agent-crm: 1,123 tokens, 1 LLM call, done.

Both drafts produced were valid (referenced the right contact, a real fact, the prior touch). One observation worth flagging but not measured systematically: HubSpot's draft for Forge fabricated "the demo we discussed last week." No demo happened — the past touch on file is an unanswered cold email. Hallucination rate is plausibly a separate quality dimension agent-crm would also win on, but we deliberately did NOT chase it — measuring it reliably would need an LLM-judge harness we don't have.

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
| Wall clock (50 parallel) | 1,306 ms | 1,628 ms |
| HTTP/RPC errors returned | 0 | 0 (!) |

**HubSpot returned HTTP 200 on every single PATCH and silently lost 48 of 50 distinct facts.** That is the most important number on this page if your buyer cares about correctness. There is no error to retry on. The integration *thinks* it succeeded.

### Method

**agent-crm side:** 50 parallel `assert_fact()` calls via the `record_event` RPC, each writing a unique fact. Append-only events, content-hashed facts, no read-modify-write anywhere in the path.

**HubSpot side:** 50 parallel writers each performing the realistic pattern for adding a fact to a HubSpot company:
1. `GET /crm/v3/objects/companies/{id}` → read current `agent_facts` text
2. Append a new line
3. `PATCH /crm/v3/objects/companies/{id}` → write merged `agent_facts`

This is the only reasonable pattern. HubSpot has no append-only fact store. Custom objects would have the same problem.

After the burst, we read `agent_facts` back and count distinct markers. 2 survived. 48 silently overwrote each other.

### Why this matters

Anyone running >1 agent against the same account on HubSpot hits this. The correctness cost is invisible: PATCH says success, the data is gone. agent-crm beats it by **not having the problem at all** — every write is an event, events compose by appending, reads are projections.

You cannot benchmark this as "5× better" — it's a categorical capability gap. Less relevant for solo-founder buyers running 1-2 agents serially; very relevant the moment a customer adds a second agent on the same accounts.

---

## Workload 5: Provenance recovery

**Scenario:** A decision agent cited `fact_id=e856db03-...` ("Resona uses_stack=bun"). Walk the chain back: where did this fact come from, who wrote it, and what's the verifiable history?

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

---

## Workload 6: Replayability

**Scenario:** Reconstruct the full state of an account at a past timestamp. Test case: at T1 we had Resona with `uses_stack=python`; at T2 we superseded that with `uses_stack=bun`. Replay state at T1 should show python; at T2 should show bun.

### Results

**agent-crm:** `replay_to(workspace_id, ts)` is a single Postgres RPC that filters events to `created_at <= ts` and re-projects state. Output is deterministic JSON.

| Replay timestamp | uses_stack facts on Resona |
|---|---|
| T_before (just before the supersede event) | typescript, postgres, **python** |
| T_after (now) | typescript, postgres, **bun** |
| Determinism (same call twice) | identical results ✓ |

**HubSpot:** no equivalent.

| Attempt | Result |
|---|---|
| `GET /crm/v3/objects/companies/{id}/snapshot?at=<ts>` | 404 — no such endpoint |
| `propertiesWithHistory=<all>` | Per-property version list. No time filter. Each version has `(value, timestamp, sourceType, sourceId)`. No actor identity, no prompt_hash, no action verb, no causal parent. |

agent-crm: 1 RPC. HubSpot: nontrivial reconstruction that still can't rerun agent reasoning.

---

## Outstanding workloads

Not yet run:

2. **Latency per autonomous decision** — currently tied (~4s both sides on Workload 1a, ~4s vs ~5s on Workload 1b), dominated by LLM call time, not data layer.
4. **Subscription matching throughput** — 10k signals × 1k subscriptions in single SQL on agent-crm. HubSpot has no comparable operation (workflows are coarse triggers, not vector matches).

---

## What's still measurable but we deferred

- **Hallucination rate** in HubSpot drafts vs agent-crm drafts. One anecdote from the Forge walkthrough suggests HubSpot's prose-fed drafts fabricate more, but n=1 isn't evidence. Would need an LLM-judge harness applied across all 36 drafts to make a defensible claim.
- **Pain-extraction yield** on real production signals. The new enricher prompt extracts `pain_observed` facts (validated on synthetic fixtures — see `scripts/test_pain_extraction.ts`), but yield on real signals from current connectors is unmeasured.

---

## Reproducing

```bash
pnpm seed                                                    # populate agent-crm with demo data
pnpm exec tsx benchmark/runners/hubspot/mirror_seed.ts       # mirror company-level data to HubSpot
pnpm exec tsx scripts/seed_drafter_benchmark.ts              # seed parity contacts + past touches

# Workload 1a (single decision — DEPRECATED, kept for reproducibility)
pnpm exec tsx benchmark/runners/agent-crm/run.ts
pnpm exec tsx benchmark/runners/hubspot/run.ts
pnpm exec tsx benchmark/runners/hubspot/run_default.ts

# Workload 1b (realistic drafter — THE HEADLINE)
pnpm exec tsx benchmark/runners/agent-crm/run_drafter.ts
pnpm exec tsx benchmark/runners/hubspot/run_drafter.ts

# Single-account verification trace
pnpm exec tsx scripts/demo_drafter_walkthrough.ts "Forge Robotics"

# Workload 3
pnpm exec tsx benchmark/runners/agent-crm/concurrency.ts
pnpm exec tsx benchmark/runners/hubspot/concurrency.ts

# Workloads 5 & 6 (capability demos)
pnpm exec tsx benchmark/runners/agent-crm/provenance.ts
pnpm exec tsx benchmark/runners/hubspot/provenance.ts
pnpm exec tsx benchmark/runners/agent-crm/replay.ts
pnpm exec tsx benchmark/runners/hubspot/replay.ts
```

Raw metrics: `benchmark/metrics/{token_cost,drafter,concurrency,provenance,replay}_{agent-crm,hubspot}.json`.

---

## Recommended pitch language

**Use:**
> "On a realistic drafter task — find the right contact, check past touches, draft a personalized email — agent-crm uses 4× fewer LLM tokens and makes 1 LLM call vs HubSpot's 4. Cost gap widens as workflow complexity grows. HubSpot can't close it by reformatting because the multi-call requirement is structural to their data model."

For correctness:
> "Run more than one agent against the same account on HubSpot and you silently lose 96% of writes. agent-crm loses 0% because every write is an event, not a row update."

**Don't use:**
> ~~"1.28× more token efficient than HubSpot."~~ (dead — see Workload 1a above)
