# v1 Benchmark Methodology

How the cost numbers are produced and how to verify them yourself. The short version: every run's token counts are committed to this repo, and `pnpm benchmark:v1:audit` re-derives the whole table from them with no API keys and no live calls.

## What is measured

One **agent action** on a single account, across three workloads:
- **draft** — write a personalized follow-up email referencing a company fact and the prior touch
- **brief** — a pre-meeting summary
- **score** — a 0-10 outreach-priority score

Each workload runs against five platforms. The agent's job is identical on every platform; the only thing that differs is how it reads the account data.

## The cost formula

```
cost = (input_tokens * input_price + output_tokens * output_price) / 1_000_000
```

- Model: `deepseek-reasoner` (v4 reasoning), the same model on **every** side of every comparison. See `lib/llm.ts`.
- Price: **$0.14 / M input, $0.28 / M output**. Source: DeepSeek published pricing, cache-miss input, May 2026. Defined once in `lib/pricing.ts` and reused by the summary generator and the audit.
- Pricing is cache-miss for everyone. That is the fair comparison: prompt caching would lower every platform's bill and, because it discounts re-sent context, would help the multi-call platforms at least as much as us. We do not lean on it.

## Sampling

- 6 accounts x 3 runs per (workload, platform, shape) = 18 samples per cell.
- 702 total runs, 696 ok, 6 failed. Variance bands are wide at n=18; treat the ratios as "2-6x," not as four significant figures.
- agent-crm is measured in its production text format (`prod-text` shape). The row-based CRMs are measured in their leanest field selection (`tight` shape), which is the most favorable to them.

## The verified numbers (mean cost per action, mean of the three workload means)

| Platform | $/action | vs agent-crm | mean LLM calls |
|---|---|---|---|
| **agent-crm** (prod-text) | $0.000475 | 1.0x | 1.00 |
| Twenty (tight) | $0.000533 | 1.12x (tied) | 2.11 |
| HubSpot (tight) | $0.001238 | 2.6x | 3.44 |
| Day.ai (tight) | $0.002402 | 5.0x | 4.95 |
| Attio (tight) | $0.002769 | 5.8x | 3.22 |

Run `pnpm benchmark:v1:audit` to reproduce this exactly from the committed `results/runs.jsonl`.

## Why the gap exists: the sequence of LLM calls

An LLM is stateless between calls. If reading the data takes several steps, every step re-sends the whole transcript so far. That re-sending is the cost. The only thing that drives the gap is how many round trips the read takes and how much data rides along on each.

- **agent-crm — 1 LLM call.** The account's data is assembled by cheap database reads *before* the model is invoked (one bundled projection: entity + facts + contacts + past touches + signals). The model is called once, sees everything, produces the output. Measured draft input: ~1,138 tokens.

- **HubSpot / Day.ai / Attio — 3 to 6 LLM calls.** The agent is given per-object tools (get company, then get contacts, then get notes) because the data lives behind separate REST endpoints with no "give me all of it" call. Each fetch is its own round trip, and each round trip re-sends everything before it. Measured draft input: HubSpot ~8,902, Day.ai ~16,552, Attio ~21,044 tokens. The data gets re-sent on every step, which is the whole gap.

- **Twenty — 2 LLM calls, and it ties us.** Twenty is a plain row-based CRM, but it has a GraphQL API. GraphQL lets the caller fetch a nested shape ("company + people + notes, these fields") in one query, so the data comes back bundled in a single response, like our projection. The only overhead vs us is one extra lightweight round trip (the model emits the query, then consumes the result). Measured draft input: ~2,571 tokens. Result: within 12% of us.

The honest read: the cost advantage is "bundle the read into one or two round trips" vs "loop object by object." We bundle with a pre-built projection; Twenty bundles with GraphQL; the granular-REST CRMs cannot bundle out of the box, so their agents loop. We claim the advantage against the granular-REST CRMs (HubSpot, Day.ai, Attio) and disclose the Twenty tie.

## Why Day.ai is simulated

Day.ai has no free tier, so we did not hit its live API. Instead `lib/dayai/simulator.ts` transforms the agent-crm projection into Day.ai's response shape as published in their SDK schema, and the same LLM workload runs over those responses. This faithfully models their data shape and the resulting tool-loop, but it is not live Day.ai data. The simulator is committed; read it. HubSpot, Attio, and Twenty are real live APIs.

## How to audit a single number

Every run is a line in `results/runs.jsonl` with its `input_tokens` and `output_tokens`. Per-call detail is in `receipts/`. To check one cost by hand, take a run's tokens and apply the formula. Worked example, the agent-crm draft mean (1,138 in, 1,205 out):

```
(1138 * 0.14 + 1205 * 0.28) / 1_000_000
= (159.32 + 337.40) / 1_000_000
= $0.000497
```

which is exactly the draft cell in the audit output. `pnpm benchmark:v1:audit` does this aggregation across all 696 ok runs and also checks that `input + output == total` on every row.

## What this benchmark does NOT claim

- **Quality is measured separately.** This file covers cost and round-trip count. Draft quality and hallucination are measured by a blind judge in `QUALITY.md` (`pnpm benchmark:v1:quality`). Short version: agent-crm produced the fewest unsupported claims and highest-quality drafts among the live platforms, but it is not a clean sweep and one platform's result is excluded as confounded. Read that file, not a summary of it.
- **Not "cheaper than everything."** Twenty ties us on cost. The claim is against the granular-REST CRMs a buyer actually evaluates.
- **No claims about competitor internals.** We report what their agents cost to run against their real (or, for Day.ai, published-schema) APIs, not what they could theoretically build.
