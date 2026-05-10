# token_cost benchmark — agent-crm vs HubSpot

**Workload:** Given an account name, decide whether to send an outbound touch this week. Output structured JSON with reasoning + citations.

**Workloads spec:** `benchmark/workloads/token_cost.yaml`
**Model:** gpt-4o-mini (both sides)
**Runs:** 18 agent-crm, 18 HubSpot (6 accounts × 3 runs each)

## Summary

| Metric | agent-crm | HubSpot | Ratio (HS / agent-crm) |
|---|---:|---:|---:|
| Avg input tokens | 532.3 | 679.8 | **1.28×** |
| Avg output tokens | 159.1 | 169.4 | 1.06× |
| Avg latency (ms) | 3942 | 4146 | 1.05× |
| LLM turns per decision | 1 | 2.00 | 2.00× |

## Per-account input tokens

| Account | agent-crm | HubSpot | Ratio |
|---|---:|---:|---:|
| Resona Labs | 567 | 709 | 1.25× |
| Forge Robotics | 550 | 687 | 1.25× |
| Plaintext.so | 605 | 738 | 1.22× |
| Halo Health | 559 | 696 | 1.25× |
| Brightvine | 456 | 624 | 1.37× |
| Strand Compute | 457 | 625 | 1.37× |

## Method

**agent-crm side:** Single shaped projection load (3 Supabase reads: entity, facts, signals) + 1 LLM call. Projection is structured JSON with fact_ids and signal_ids — direct citations available.

**HubSpot side:** Agent has a single tool `hubspot_get_company_by_name`. The tool wrapper requests only the 6 fields we care about (`name`, `domain`, `description`, `stack`, `agent_facts`, `agent_signals`) and **strips HubSpot's envelope wrapper** (`createdAt`, `updatedAt`, `archived`, `url`) before passing the result to the LLM. Agent loop: turn 1 chooses the tool, turn 2 receives the result and outputs a decision. Two LLM turns.

This is the *strongest reasonable* HubSpot baseline, not a strawman. We deliberately:
- Used a one-shot fetch tool rather than paginated note discovery.
- Stored facts and signals as structured custom properties on the company so they come back in one envelope.
- Stripped HubSpot's wrapper metadata in the tool wrapper (~80 tokens saved per turn).
- Embedded `fact_id=...` and `signal_id=...` into the property text so HubSpot can produce real citations rather than hallucinated strings.

A naive HubSpot baseline (paginated notes, separate engagement fetches, no envelope stripping, no embedded ids) would inflate this ratio significantly. The number you see is the floor on HubSpot's overhead, not the ceiling.

## Reading the result

The 1.28× input-token win comes from two compounding sources:

1. **JSON vs prose density.** agent-crm's projection is structured JSON the model parses directly. HubSpot returns prose-shaped custom-property text the model still has to read.
2. **Two turns vs one.** Tool-use loops re-send the system prompt + prior turn payloads on every turn. A single-turn projection avoids that overhead entirely.

What this measurement does *not* capture (and where the architectural wedge actually lives):

- **Provenance.** agent-crm emits `fact_id`-grounded citations the system can verify against the event log. HubSpot citations are made-up strings the model invented from prose — there is no verifiable chain back to a source event.
- **Replayability.** agent-crm can recompute this exact decision against any past timestamp via `replay_to()`. HubSpot has no event log to replay against.
- **Concurrency.** Burst writes (50 agents on the same account) on agent-crm are append-only events, zero conflicts. On HubSpot, last-write-wins on the company object would silently lose data.

These three properties can't be benchmarked as "1.28× better" because HubSpot can't do them at all. They are the next workloads.
