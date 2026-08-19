# Benchmark

The current, verified results live in **`benchmark/v1/WRITEUP.md`**: 5 real platforms (HubSpot, Day.ai, Attio, Twenty, agent-crm), real APIs, the same DeepSeek-reasoner model on every side, 696 successful runs, every receipt committed to the repo.

**Headline — mean cost per agent action** (reproduce from the committed run data with `pnpm benchmark:v1:audit`, no API keys needed):

| Platform | $/action | vs agent-crm | mean LLM calls |
|---|---|---|---|
| **agent-crm** | $0.000994 | 1.0x | 1.00 |
| Twenty | $0.001030 | 1.04x (tied) | 2.11 |
| HubSpot | $0.002243 | **2.26x** | 3.44 |
| Day.ai | $0.004308 | **4.33x** | 4.95 |
| Attio | $0.004702 | **4.73x** | 3.22 |

Priced at DeepSeek's 2026-08 rates ($0.22/M in, $0.66/M out). **These are the numbers the audit
script prints today.** An earlier version of this table quoted $0.000475 / 2.6x / 5.0x / 5.8x, which
was the same run data priced at DeepSeek's May 2026 rates against the prod-text read shape. The
ratios move whenever the model price moves, so re-run the audit before quoting any of them.

agent-crm hands the agent one bundled read (1 LLM call). The row-based CRMs expose data per object, so the agent loops 3-6 calls and re-sends context on each one. Twenty ties because its GraphQL API bundles the read the same way we do; the gap is against the granular-REST CRMs (HubSpot, Day.ai, Attio).

Method, the call-sequence explanation, why Day.ai is simulated, and a worked receipt-audit example are in **`benchmark/v1/METHODOLOGY.md`**.

The earlier v0 benchmark (the `4.22x` drafter claim, gpt-4o-mini vs stubbed HubSpot) is archived at **`benchmark/v0_ARCHIVE.md`** and should not be cited.
