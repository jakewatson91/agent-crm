# Benchmark

The current, verified results live in **`benchmark/v1/WRITEUP.md`**: 5 real platforms (HubSpot, Day.ai, Attio, Twenty, agent-crm), real APIs, the same DeepSeek-reasoner model on every side, 696 successful runs, every receipt committed to the repo.

**Headline — mean cost per agent action** (reproduce from the committed run data with `pnpm benchmark:v1:audit`, no API keys needed):

| Platform | $/action | vs agent-crm | mean LLM calls |
|---|---|---|---|
| **agent-crm** (prod-text) | $0.000475 | 1.0x | 1.00 |
| Twenty | $0.000533 | 1.12x (tied) | 2.11 |
| HubSpot | $0.001238 | **2.6x** | 3.44 |
| Day.ai | $0.002402 | **5.0x** | 4.95 |
| Attio | $0.002769 | **5.8x** | 3.22 |

agent-crm hands the agent one bundled read (1 LLM call). The row-based CRMs expose data per object, so the agent loops 3-6 calls and re-sends context on each one. Twenty ties because its GraphQL API bundles the read the same way we do; the gap is against the granular-REST CRMs (HubSpot, Day.ai, Attio).

Method, the call-sequence explanation, why Day.ai is simulated, and a worked receipt-audit example are in **`benchmark/v1/METHODOLOGY.md`**.

The earlier v0 benchmark (the `4.22x` drafter claim, gpt-4o-mini vs stubbed HubSpot) is archived at **`benchmark/v0_ARCHIVE.md`** and should not be cited.
