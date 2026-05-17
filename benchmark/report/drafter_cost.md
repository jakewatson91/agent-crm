# Realistic drafter cost benchmark — agent-crm vs HubSpot

**Task:** Draft a personalized follow-up email to the best contact at an account,
referencing one specific fact about the company AND the prior touch.

This is what the agent does for every account in a real outbound flow. The
"single tool call to decide yes/no" benchmark in `token_cost.md` measures one
slice of one decision; this measures what it costs to do a useful piece of work.

**Workload spec:** to be added at `benchmark/workloads/realistic_drafter.yaml`
**Model:** gpt-4o-mini (both sides)
**Runs:** 18 agent-crm, 18 hubspot (6 accounts × 3 runs each)

## Summary

| Metric | agent-crm | HubSpot | Ratio (HS / agent-crm) |
|---|---:|---:|---:|
| Avg input tokens | 1,084 | 4,575 | **4.22×** |
| Avg output tokens | 126 | 173 | 1.37× |
| Avg latency (ms) | 3,757 | 5,312 | 1.41× |
| Avg LLM calls per task | **1.00** | **3.94** | 3.94× |
| Avg data-store calls per task | 5 (Supabase reads, bundled) | 3.00 (HubSpot REST) | — |

## Per-account input tokens

| Account | agent-crm | HubSpot | Ratio |
|---|---:|---:|---:|
| Resona Labs | 1,063 | 10,763 | **10.13×** |
| Forge Robotics | 1,155 | 3,445 | 2.98× |
| Plaintext.so | 1,250 | 3,300 | 2.64× |
| Halo Health | 1,064 | 3,457 | 3.25× |
| Brightvine | 981 | 3,239 | 3.30× |
| Strand Compute | 990 | 3,248 | 3.28× |

Resona is the outlier because its accumulated `agent_facts` blob in HubSpot is
~5,400 chars and every additional LLM turn re-sends it. agent-crm pages signals
and dedupes facts in the projection, so the size stays bounded.

## Why the gap

**agent-crm** runs one Supabase query (5 small reads bundled) that returns a
unified projection: entity + active facts + contacts + past touches + recent
signals. The LLM gets this in **one turn** and emits the draft.

**HubSpot** has companies, contacts, and engagements in three separate tables
traversed via associations. The drafter MUST call three tools to write a
personalized email: `get_company`, `get_associated_contacts`, `get_recent_notes`.
Each tool turn re-sends the system prompt, the user message, every prior tool
call, AND every prior tool result. So a 4-turn loop pays for the full context
four times.

This is structural, not a format choice. HubSpot cannot reformat their way out
of it — the multi-call requirement is intrinsic to a row-oriented CRM with
entities split across tables.

## Dollar cost

At **gpt-4o-mini** ($0.15 / 1M input, $0.60 / 1M output):

| Workload | agent-crm | HubSpot | Difference |
|---|---:|---:|---:|
| 500 drafts/week | $0.12 / wk ($6 / yr) | $0.40 / wk ($21 / yr) | 3.3× |
| 5,000 drafts/week | $1.20 / wk ($62 / yr) | $4.00 / wk ($205 / yr) | 3.3× |

At **gpt-4o** ($2.50 / 1M input, $10 / 1M output):

| Workload | agent-crm | HubSpot | Difference |
|---|---:|---:|---:|
| 500 drafts/week | $1.98 / wk ($103 / yr) | $6.58 / wk ($342 / yr) | 3.3× |
| 5,000 drafts/week | $19.80 / wk ($1,030 / yr) | $65.80 / wk ($3,420 / yr) | 3.3× |

At **Claude Sonnet 4.6** ($3 / 1M input, $15 / 1M output):

| Workload | agent-crm | HubSpot | Difference |
|---|---:|---:|---:|
| 5,000 drafts/week | $25.70 / wk ($1,335 / yr) | $81.60 / wk ($4,243 / yr) | 3.2× |

Per-decision the dollar gap is small. At scale and on stronger models it's
material. The compounding scales with workflow complexity: every additional
piece of context the drafter needs (deals, recent emails, support tickets)
adds another HubSpot tool turn that re-bills the entire context.

## Other things measured

- **Latency:** 1.41× slower on HubSpot (5.3s vs 3.8s). Each tool turn is a
  network round trip + LLM call. The founder sees this as "the draft is slow."
- **Failure surface:** 3.94 LLM calls per task means ~4× more places the loop
  can stall, refuse, or hallucinate. agent-crm has one place to fail.
- **Total billed tokens (input + output) per task:** 1,210 (agent-crm) vs
  4,748 (HubSpot) = 3.92×.

## Method notes

**agent-crm side:** real Supabase, real workspace data, no stubbing. Five
queries (entity, facts, works_at facts → contact ids, contact entities,
channel + posts, signals) bundled into one tool round-trip. One LLM call,
JSON response_format enforced.

**HubSpot side:**
- `hubspot_get_company_by_name` hits the real HubSpot API
  (`/crm/v3/objects/companies/search`) with the realistic default-setup
  property request — no envelope stripping, no hand-picked 6-field whitelist.
- `hubspot_get_associated_contacts` and `hubspot_get_recent_notes` are
  STUBBED locally using documented HubSpot v3 response shapes. Our service
  key lacks contacts/engagements scope — a real customer would have both.
  Content matches the agent-crm seed verbatim, only the shape differs.
- Stub fidelity is documented in `benchmark/runners/hubspot/run_drafter.ts`.

**Honest caveats:**
- A founder using HubSpot might consolidate contacts + notes into a custom
  textarea property (same trick as `agent_facts`). That would drop turns 2-3
  but lose structure entirely and still leaves them above 1× because the
  initial company response is already ~3× the projection.
- The reverse: agent-crm could project even tighter (drop UUIDs in favor of
  short tags) and shave another ~30%. We haven't, because the gap is already
  decisive at the realistic format.

## What this number means for the pitch

Use this, not the original `token_cost.md` 1.28× number. That benchmark
measured a "decide yes/no" task with a single tool call. It's not what the
agent actually does.

**Real number to quote: ~3-4× cheaper per useful task, with the gap widening
as workflow complexity grows.** And critically: HubSpot can't close this gap
by reformatting. The multi-call requirement is structural to their data model.
