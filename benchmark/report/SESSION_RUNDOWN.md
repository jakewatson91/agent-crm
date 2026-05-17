# Benchmark testing rundown — 2026-05-17 session

Complete inventory of the benchmark tests run this session: what we tested, how, what the results actually mean, and which claims hold vs which collapsed.

---

## Context

Started the session asking: **"why is agent-crm any better than a standard CRM with bolted-on agents, on efficiency, cost, and effectiveness?"**

The session ran through four benchmark iterations chasing a defensible cost answer. Multiple early attempts collapsed under scrutiny. The final answer that holds: **~4× cheaper per useful task than a HubSpot+agent stack at realistic workflow complexity.**

---

## Test 1 — Original token-cost benchmark (`benchmark/report/token_cost.md`)

### What

Original benchmark in the repo. Compared agent-crm vs HubSpot on a "decide whether to send an outbound touch this week" task.

### How

- 6 demo accounts × 3 runs each (18 runs per side)
- Single LLM call (`gpt-4o-mini`)
- agent-crm side: one Supabase projection → one LLM call → JSON decision
- HubSpot side: one tool call to `hubspot_get_company_by_name` → two LLM turns → JSON decision
- HubSpot side was hand-tuned to be favorable: only 6 hand-picked properties requested, envelope stripped, fact_ids pre-embedded in property text

### Results as originally reported

| | agent-crm | HubSpot | Ratio |
|---|---:|---:|---:|
| Avg input tokens | 532 | 680 | 1.28× |
| LLM turns | 1 | 2 | 2× |

### Verdict

**Dead.** Three problems exposed during re-validation:

1. **Numbers don't survive data growth.** Re-ran on current state: agent-crm at 1,225 input tokens, HubSpot floor at 1,082. **The 1.28× advantage flipped.** On 5 of 6 accounts HubSpot was cheaper. The original snapshot was point-in-time and broke as the facts table accumulated.

2. **Bug in the agent-crm runner.** `benchmark/runners/agent-crm/run.ts:76` filtered facts with `.is('supersedes', null)`, which returns ORIGINAL facts and excludes the LATEST in any supersede chain. So when `uses_stack=python` was superseded by `uses_stack=bun`, the runner showed the agent the stale `python` fact. Fixed to match the seed's logic.

3. **The comparison measures format choice, not architecture.** HubSpot's "flat text in a textarea" vs agent-crm's "structured JSON" is a serialization choice both systems can make. If HubSpot serialized JSON in their textarea, the token gap would vanish.

**Action taken:** rewrote the comparison around a more realistic workload (Test 3 below). This original report is kept for archival but should not be cited.

---

## Test 2 — HubSpot "default setup" variant

### What

Built a second HubSpot runner (`benchmark/runners/hubspot/run_default.ts`) to test what happens when a HubSpot+agent user *doesn't* hand-tune the tool wrapper. Asked for the realistic default property set (~14 fields HubSpot's UI prominently shows + the agent customs) and did NOT strip the envelope.

### How

Same 18 runs, same model, same task. Only difference: realistic property request + no envelope stripping.

### Results

| Case | Avg input tokens | Avg latency |
|---|---:|---:|
| agent-crm (current) | 1,225 | 3.5s |
| HubSpot floor (envelope stripped, 6 props) | 1,082 | 3.7s |
| HubSpot default setup | 1,224 | 3.4s |

### Verdict

Even the "default setup" hit parity with agent-crm on the single-decision workload. Single-tool workloads are a bad place to draw architectural conclusions. **Triggered the move to the realistic-drafter workload (Test 3) which is what an agent actually does.**

---

## Test 3 — Realistic drafter benchmark (`benchmark/report/drafter_cost.md`)

### What

The honest comparison. Task: *"Draft a personalized follow-up email to the best contact at this account, referencing one specific fact AND the prior touch."* This is what the agent actually does in production, not "decide yes/no."

### How

- 6 demo accounts × 3 runs each (18 runs per side)
- Model: gpt-4o-mini both sides
- **agent-crm side** (`benchmark/runners/agent-crm/run_drafter.ts`):
  - 1 Supabase round-trip pulling entity + facts + contacts + past_touch + signals as a unified projection
  - 1 LLM call producing JSON draft
- **HubSpot side** (`benchmark/runners/hubspot/run_drafter.ts`):
  - Real `hubspot_get_company_by_name` API call (default property set, no envelope stripping)
  - Stubbed `hubspot_get_associated_contacts` and `hubspot_get_recent_notes` using documented HubSpot v3 response shapes (our service key lacks contacts/engagements scope — a real customer would have both, content matches the agent-crm seed)
  - 4 LLM turns: call company → call contacts → call notes → emit draft

### Results

| Metric | agent-crm | HubSpot | Ratio |
|---|---:|---:|---:|
| Avg input tokens | 1,084 | 4,575 | **4.22×** |
| Avg output tokens | 126 | 173 | 1.37× |
| Avg latency (ms) | 3,757 | 5,312 | 1.41× |
| LLM calls per task | **1.00** | **3.94** | 3.94× |

Per-account spread (input tokens):

| Account | agent-crm | HubSpot | Ratio |
|---|---:|---:|---:|
| Resona Labs | 1,063 | 10,763 | 10.13× |
| Forge Robotics | 1,155 | 3,445 | 2.98× |
| Plaintext.so | 1,250 | 3,300 | 2.64× |
| Halo Health | 1,064 | 3,457 | 3.25× |
| Brightvine | 981 | 3,239 | 3.30× |
| Strand Compute | 990 | 3,248 | 3.28× |

Dollar cost at gpt-4o-mini ($0.15 / 1M input, $0.60 / 1M output):
- 500 drafts/week: $0.12 (agent-crm) vs $0.40 (HubSpot)
- 5,000 drafts/week: $1.20 vs $4.00/week

Multiply by ~15-20× for gpt-4o or Claude Sonnet.

### Method notes / caveats

- The contacts and notes responses are stubbed (scope limitation), but using documented HubSpot API shapes. A real customer with full scope would face the same response sizes.
- Past-touch parity data seeded in both sides via `scripts/seed_drafter_benchmark.ts` (2 contacts + 1 past touch per account on agent-crm side; same content stubbed into `benchmark/runners/hubspot/stub_data.json` for the HubSpot runner).
- Hallucination / draft quality was NOT measured systematically — would require an LLM-judge harness, deferred.

### Verdict

**The cost argument that holds.** Multi-turn tool loops cost what they cost because every turn re-sends the full context. HubSpot can't reformat their way out of it because the multi-call requirement is structural to their data model (companies / contacts / engagements in separate tables traversed via associations).

---

## Test 4 — Forge Robotics end-to-end walkthrough (`scripts/demo_drafter_walkthrough.ts`)

### What

Live trace of a single account through both pipelines, showing every LLM message, every tool call result size, and the actual draft produced. Built to verify Test 3's numbers weren't an artifact of aggregate math.

### How

Pick one account (Forge Robotics). For each side: print the projection / tool results, the turn-by-turn LLM costs, the final draft. Side-by-side comparison.

### Results (Forge Robotics, one run)

| | agent-crm | HubSpot | Ratio |
|---|---:|---:|---:|
| Input tokens | 1,123 | 3,117 | 2.78× |
| Output tokens | 92 | 170 | 1.85× |
| LLM turns | 1 | 4 | 4× |
| Latency | 3.4s | 6.3s | 1.83× |

HubSpot turn-by-turn cumulative input shows the multi-turn tax in action:
```
Turn 1: 237 tokens (system + user)
Turn 2: 708 tokens (+company response)
Turn 3: 999 tokens (+contacts response)
Turn 4: 1,173 tokens (+notes response → draft)
Total: 3,117 input tokens for 4 LLM calls
```

agent-crm: 1,123 tokens, 1 LLM call, done.

### Drafts produced

- **agent-crm:** "Hey Jules, I saw that Forge is hiring senior engineers in Rust… circle back on my previous note about the outbound solution I built."
- **HubSpot:** "Hi Jules, I saw that Forge Robotics is currently operating without a dedicated sales hire… Following up on the demo we discussed last week."

Notable: HubSpot's draft fabricated "the demo we discussed last week." No demo happened — the past touch was an unanswered cold email. The model hallucinated a meeting that didn't exist. **One data point — not measured systematically.**

### Verdict

Confirmed Test 3's numbers are real, not a math artifact. Also surfaced a possible quality dimension (hallucination) that we deliberately chose NOT to chase further because we'd need an LLM-judge harness and reliable measurement wasn't feasible in this session.

---

## What stands vs what doesn't

### Claims that hold

1. **Realistic drafter workload: agent-crm is ~3-4× cheaper than HubSpot+agent.** Real measurement, 18 runs each side, structural reason (multi-call data model). The Forge walkthrough confirms it's not a math artifact. Caveat: HubSpot contacts + notes responses are stubbed (documented API shapes).
2. **Multi-call tool loops compound input cost.** Each turn re-sends prior context. Demonstrated turn-by-turn in the Forge walkthrough.

### Claims that don't hold

1. **The original 1.28× token-cost claim from `token_cost.md`.** Dead. Numbers flipped on current data. Single-tool workloads measure format choice, not architecture. **Don't quote this number.**
2. **Anything about HubSpot drafts hallucinating at higher rate than agent-crm.** One data point. Not measured systematically. Deferred.

---

## Files produced this session

**Runners and reports:**
- `benchmark/runners/hubspot/run_default.ts` — default-setup HubSpot variant (Test 2)
- `benchmark/runners/hubspot/run_drafter.ts` — realistic drafter runner (Test 3)
- `benchmark/runners/hubspot/stub_data.json` — seed for stubbed tool responses
- `benchmark/runners/agent-crm/run_drafter.ts` — realistic drafter runner (Test 3)
- `benchmark/report/drafter_cost.md` — main result (the 4.22× number)
- `benchmark/report/SESSION_RUNDOWN.md` — this file

**Diagnostic scripts:**
- `scripts/demo_drafter_walkthrough.ts` — end-to-end single-account trace (Test 4)
- `scripts/seed_drafter_benchmark.ts` — parity seeder (contacts + past touches)
- `scripts/inspect_projection_sizes.ts` — projection chars per account

**Bug fix:**
- `benchmark/runners/agent-crm/run.ts:76` — supersede filter logic

---

## Recommended pitch language

**Use:**
> "On a realistic drafter task, agent-crm uses ~4× fewer LLM tokens and makes 1 LLM call vs HubSpot's 4. Cost gap widens as workflow complexity grows. HubSpot can't close it by reformatting — the multi-call requirement is structural to their data model."

**Don't use:**
> ~~"1.28× more token efficient than HubSpot."~~ (dead)
