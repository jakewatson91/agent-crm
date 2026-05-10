# Agentic system design interview: blueprint

A study doc for "design an agentic system that does X" interviews. The goal is to give you the patterns, trade-offs, and frameworks that apply broadly. The agent-crm codebase is referenced as a worked example, not the focus.

How to use this doc:
1. Read Parts 1-7 to internalize the patterns and the framework.
2. Use Part 8 to drill practice questions out loud.
3. Use Part 9 as worked examples for famous "design X" prompts.

---

# Part 1. The agentic system design framework

Every agentic system design question, no matter the domain, decomposes into the same seven layers. Walk into the interview and sketch these:

```
┌────────────────────────────────────────┐
│  1. INPUT / TRIGGER SURFACE             │   what kicks the agent off
├────────────────────────────────────────┤
│  2. INGEST + NORMALIZATION              │   raw input → structured signal
├────────────────────────────────────────┤
│  3. ROUTING / PREDICATE LAYER           │   which agent should care
├────────────────────────────────────────┤
│  4. AGENT RUNTIME                       │   reason, decide, act
├────────────────────────────────────────┤
│  5. TOOL / ACTION SURFACE               │   side effects on the world
├────────────────────────────────────────┤
│  6. STATE + MEMORY                      │   what we know, where it lives
├────────────────────────────────────────┤
│  7. OBSERVATION + GATES                 │   audit, debug, human override
└────────────────────────────────────────┘
```

For each layer, an interviewer wants to hear:
- What goes there
- Why you chose it
- The trade-offs you accepted
- The failure modes
- The scaling story

If you do nothing else, drill on these seven layers until they are reflexive.

---

# Part 2. Core patterns and components

Each section: what it is, when to use it, why it beats the alternative, what it costs you.

## 2.1 Event sourcing

**What:** every state change is appended to an immutable log. Tables you query (`entities`, `facts`, `claims`) are projections of the log.

**When to use:**
- The system needs an audit trail by default.
- Multiple writers (agents, humans, batch jobs) modify the same records.
- "Why did the agent decide X?" must be answerable.
- Time-travel queries are part of the product (compliance, replay).

**Why over CRUD:**
- Replay is free. Reconstruct state at any past moment by re-applying events up to a timestamp.
- Concurrent writes don't conflict at the row level. Two agents asserting the same fact write two events; the projection deduplicates.
- Audit is a side effect, not a separate system that drifts from reality.

**Cost:**
- Read amplification on hot rows. Always need a projection.
- More storage (every change is permanent).
- Complexity in eventual-consistency moments between event arrival and projection update.

**Reference:** Datomic, Kafka + materialized views, EventStore, Apache Iceberg.

## 2.2 Content-addressed records

**What:** primary key is `hash(content)`. Two writes of identical content produce the same ID.

**When to use:**
- Idempotency under retry is required.
- Writers are non-deterministic (LLMs, distributed agents) and may duplicate.
- Deduplication has business meaning ("we already have this fact").

**Why over auto-increment IDs or UUIDs:**
- Idempotent inserts. Retry safely. No "duplicate row" cleanup.
- Natural deduplication. Two agents reach the same conclusion, no race.
- Sharing across tenants is safe (same content, same hash).

**Cost:**
- Records can't be edited in place. To "change" content, write a new record and link via supersede chain.
- Hash collisions theoretical with sha256, never seen in practice.

**Reference:** Git (blobs are content-addressed), IPFS, Docker layers.

## 2.3 Durable workflow execution

**What:** the workflow engine checkpoints each step. If the function dies, retry resumes from the last completed step, not from the beginning.

**When to use:**
- Workflows have multiple LLM calls or external API calls.
- Each step has expensive side effects you don't want to repeat.
- Steps can take minutes (LLM calls, batch jobs).

**Engines compared:**

| Engine | Model | Best for | Trade-off |
|---|---|---|---|
| Inngest | Webhook-based, durable steps | TypeScript serverless, cron + events | Vendor dependency, function size limits |
| Temporal | Long-running workers | Java/Go primary, complex orchestration | Heavy infra: workers, persistence, UI |
| AWS Step Functions | State machine via JSON | AWS-native, batch and ETL | Verbose, harder to test locally |
| BullMQ + custom | Redis-backed queue | DIY full control | You build retries, checkpointing, dashboards |
| Trigger.dev | Similar to Inngest | TypeScript with v3 SDK | Newer, smaller community |

**Key concept: "exactly once" is a lie at the message level.** What you actually want is "at least once delivery" plus "idempotent handlers." Durable workflows help by checkpointing each step so the side effects you've already taken aren't repeated. Combine with content-addressed writes (2.2) for full idempotency.

## 2.4 Pub/sub on predicates (semantic + structured)

**What:** instead of routing by topic, route by predicate. Subscribers register a query like "any signal where `industry: ai_startups` AND semantically similar to 'hiring AE'." When a new event arrives, every matching subscription fires.

**When to use:**
- The number of distinct routing rules is large or grows.
- Rules combine hard filters (must be from YC) with fuzzy matches (semantically about hiring).
- Subscribers are agents that should react to many event types.

**Implementation pattern:**
```
ON insert INTO signals:
  SELECT subscription_id FROM subscriptions
  WHERE structured_filter @> NEW.tags                       -- GIN index
    AND active = true
    AND 1 - (embedding <=> NEW.embedding) >= threshold;     -- HNSW index
  
  FOR each match: emit subscription.matched event
```

**Why over simple topic-based pub/sub:**
- One signal can fan out to many distinct interested agents without a router that knows them all.
- New subscribers don't require code changes (just insert a row).
- Combining structured + semantic gives precision (hard filter) and recall (fuzzy match).

**Cost:**
- The match query runs on every insert. At 10k+ subscriptions you need indexes; at 100k+ you need partitioning.
- Embedding storage and similarity index (HNSW) must scale with subscriptions.

## 2.5 Tool calling / function dispatch

**What:** the agent doesn't write to the database directly. It calls "tools" that translate to validated, audited writes.

**When to use:**
- Multiple agents act on the same data.
- Validation, rate limiting, or audit must be enforced.
- The tool surface evolves separately from agent prompts.

**Why over direct DB writes from the agent:**
- Central choke point. Every write goes through one path. Validation, RLS, rate limits, audit happen in one place.
- Agents can't accidentally bypass rules. Compare to "every agent re-implements the suppression check."
- Tool surface becomes the API. Agents change rapidly, tools change slowly.

**Cost:**
- New behaviors require new tools. The tool surface grows.
- Adds a layer between agent intent and database state. Slightly more debug work.

**Reference:** OpenAI function calling, Anthropic tool use, MCP (Model Context Protocol).

## 2.6 Memory hierarchies for agents

Agents need to remember things across runs. Memory is tiered like CPU caches:

| Tier | What lives here | Latency | Cost |
|---|---|---|---|
| L0 (prompt) | Current context, constitution, active facts | 0ms (in prompt) | Token cost per call |
| L1 (cached prefix) | Stable system prompt, tool schemas | <50ms (cache hit) | Cached tokens cheaper |
| L2 (working memory) | Recent conversation, recent events | 10-100ms (DB read) | Postgres rows |
| L3 (semantic recall) | Embeddings of past interactions | 50-200ms (vector search) | Vector index |
| L4 (cold archive) | Full event log over 90 days old | 1-10s (S3 read) | Object storage |

**Design principle:** pull memory inward only when relevance > threshold. Don't dump everything into the prompt.

**Common patterns:**
- **Sliding window:** last N events.
- **Summarization buffer:** rolling summary plus recent verbatim.
- **Vector recall:** retrieve top-K relevant past events by embedding similarity.
- **Entity-anchored:** load facts about the entity the agent is reasoning over.

**Cost lever:** prompt caching. If the prefix (constitution + tool schemas + KB) is stable, providers cache it after one hit. Subsequent calls pay ~10% the input token cost. Aim for >90% prefix cache hit rate.

## 2.7 Provenance and replay

**What:** every claim, draft, or decision points back to the events that produced it. Replay reconstructs state at any past timestamp.

**When to use:**
- Compliance requires "show why the agent did X."
- Debugging needs "what did the agent see when it made this call."
- Trust matters and humans verify outputs.

**Implementation:**
- Every event has a parent_event_id and a prompt_hash.
- Every projection row has a source_event_id.
- Every UI surface shows "Why this?" by reconstructing state at `decision_timestamp - 1ms`.
- A `replay_to(workspace_id, ts)` function rolls events forward to the requested time.

**Why this matters in interviews:** replay is the answer to "what about debugging." If the interviewer asks "how do you know your agent isn't hallucinating," replay is the answer.

## 2.8 Idempotency in non-deterministic systems

LLMs return different output for the same input. Retries can produce different actions. How do you keep the system consistent?

**Three layers of defense:**

1. **Content-addressed writes (2.2):** identical content collapses to one record. Even if the LLM produces the same fact twice with different prose, normalize before hashing.
2. **Idempotency keys at the action level:** every tool call carries an `idempotency_key = hash(workspace_id, signal_id, agent_id, action_type)`. Duplicate keys short-circuit.
3. **Durable workflow checkpointing (2.3):** if step 3 succeeded, retry resumes from step 4. The LLM call in step 3 doesn't run twice.

**Antipattern:** retrying the entire workflow on failure. If step 3 sent an email, retry sends it again.

## 2.9 Human-in-the-loop gates

**What:** instead of always-autonomous, the agent requests approval before high-stakes actions. The gate is a typed event with a payload the human can react to.

**When to use:**
- The action is irreversible (sending an email, making a payment).
- Confidence is low (off-ICP, thin facts, policy violation suspected).
- Compliance requires human sign-off on certain action classes.

**Pattern:**
- Agent calls `request_gate({ policy: 'off_icp', reason: '...', proposed_action: {...} })`.
- A notification fires (Slack, email, in-app).
- Human approves or rejects. Approval emits an event the agent listens for.
- Retry only the action, not the reasoning.

**Design principle:** the gates inbox should be empty when the system is healthy. A full inbox means either the rules are too strict or the agent is bad at judging.

## 2.10 Multi-tenant isolation

**What:** one logical database serves many tenants without leakage.

**Three approaches, ranked by isolation strength:**

1. **Separate database per tenant.** Strongest. Most expensive operationally.
2. **Shared database, separate schema per tenant.** Middle. Postgres can do this; complicates migrations.
3. **Shared database, shared schema, row-level isolation.** Weakest at the infra level, strongest at the dev level. Postgres RLS enforces "you can only see rows where workspace_id = your_workspace."

**For agentic systems:** option 3 is the default. Service role bypasses RLS for system writes (connectors, agent runtime). Policy checks live in SQL, not application code.

**Multi-tenant embeddings nuance:** vectors are usually partitioned by tenant. Cross-tenant similarity ("companies similar to Acme across all tenants") is a privacy decision, not an architecture decision.

## 2.11 Concurrency control for parallel agents

**Problem:** N agents may try to write to the same entity simultaneously.

**Approaches:**

| Approach | Mechanism | Fits when |
|---|---|---|
| Optimistic concurrency | Compare-and-swap on a version column | Conflicts are rare |
| Pessimistic locking | Row locks on read | Conflicts are common |
| Event sourcing + dedup | Both write events; projection collapses | Concurrent writers are the norm |
| Per-key concurrency limit | Workflow engine throttles per key | Bursts are bounded |

**Why event-sourcing + content-addressed dedup wins for agentic systems:** the access pattern is "many writers, eventually consistent reads." Pessimistic locking serializes everything (slow). Optimistic concurrency makes losers retry (wasteful). Event-sourcing lets everyone write; projection figures it out.

**Real-world reference:** Riak, Cassandra, and Dynamo use vector clocks or LWW for similar reasons.

## 2.12 Rate limiting (LLM provider edition)

LLM APIs have hard limits: requests per minute, tokens per minute, concurrent requests. Exceed them and you get 429s with retry-after headers.

**Defense in depth:**

1. **Client-side token bucket.** Track in Redis; throttle before sending.
2. **Adaptive backoff.** Honor retry-after; exponential backoff with jitter.
3. **Provider rotation.** Multiple keys, multiple providers. Round-robin or circuit-breaker.
4. **Prompt caching.** Cached tokens count less; reduces TPM pressure.
5. **Model tiering.** Cheap model for routing decisions, expensive model for the critical step.

**Cost calculation worth memorizing:**
- GPT-4-class input ~$2.50/M tokens, output ~$10/M tokens
- Claude Sonnet input ~$3/M tokens, output ~$15/M tokens  
- Embedding (text-embedding-3-small) ~$0.02/M tokens
- Cached input tokens ~10% of base cost
- A 100k-token context with 1k output: input dominates cost. Cache the prefix.

## 2.13 Observability for agentic systems

You will be asked "how do you debug this." Five layers:

1. **Structured logs at every step.** JSON with workspace_id, agent_id, signal_id.
2. **Distributed tracing.** Span per LLM call, per tool call, per DB write. OpenTelemetry.
3. **Replay UI.** Click any decision, see what the agent saw at decision time.
4. **Eval pipelines.** Sample N% of decisions, score with a critic LLM, alert on drift.
5. **Cost tracing.** Tokens per agent run, cached vs uncached, by tenant. Bill by usage.

The senior move: when asked about debugging, lead with replay. Most candidates lead with logs.

---

# Part 3. Storage decisions

## 3.1 SQL vs NoSQL vs vector

| Need | Best fit | Why |
|---|---|---|
| Joins across entities | SQL (Postgres) | Joins are first-class, planner is mature |
| High write throughput, simple keys | KV (Redis, DynamoDB) | No join cost, horizontal scale |
| Document queries with rich filters | Document DB (MongoDB) | Schema flexibility, jsonb-like queries |
| Semantic similarity search | Vector DB (pgvector, Pinecone) | HNSW or IVF index, cosine distance |
| Append-only event log at scale | Kafka, Iceberg, Delta | Optimized for sequential writes, replay |
| Time-series at scale | Timescale, ClickHouse | Compression, time-based partitioning |

**For agentic systems specifically:** Postgres with pgvector covers 90% of cases under 100k entities per tenant. Beyond that, split: relational stays in Postgres, vectors move to Pinecone or Qdrant, events move to Kafka.

## 3.2 Indexing

| Index type | When | Cost |
|---|---|---|
| B-tree | Equality, range on scalar columns | Standard, cheap |
| GIN | Containment on jsonb / arrays | Larger than B-tree, slower writes |
| HNSW | Vector similarity, low recall trade-off | Memory-heavy, build is slow |
| IVFFlat | Vector similarity, training step required | Better than HNSW at huge scale |
| BRIN | Time-series on append-only | Tiny, only useful when data is sorted |
| Bloom | Multi-column equality, point lookups | Small, probabilistic |

**Worth knowing:** HNSW is memory-resident. At 1M vectors x 1536 dims x 4 bytes = ~6GB just for vectors. Index overhead is another ~30%. Sharding becomes mandatory.

## 3.3 Sharding strategies

Three flavors:
- **By tenant.** Best for SaaS. Every query is tenant-scoped. Hot tenants are still a problem.
- **By time.** Best for event logs. Old shards become read-only.
- **By hash.** Best for KV. Keys distribute evenly. Joins are painful across shards.

**Common pitfall:** sharding too early. Postgres on a single big box (32 cores, 256GB RAM) handles 10k tenants and 100M rows fine. Don't shard until forced.

## 3.4 Hot / warm / cold tiering

For event-sourced systems with replay:

```
HOT      (last 7d)    → Postgres primary, indexed everything
WARM     (7-90d)      → Postgres, smaller indexes, possibly read replica
COLD     (>90d)       → S3 + Iceberg/Parquet, queried via Athena/Trino
```

Replay walks the tiers. Most queries hit hot only. Audit queries occasionally hit cold.

---

# Part 4. Compute decisions

## 4.1 Where does the agent run

| Option | Pros | Cons |
|---|---|---|
| Serverless function (Lambda, Vercel, Render) | No infra, scales to zero | Timeout limits (10-300s), cold starts |
| Long-running container (ECS, Fly, Render web service) | No timeout, warm always | Always-on cost, scaling lag |
| Kubernetes job per agent run | Full isolation, language flexibility | Overhead per run, slow startup |
| Workflow engine + serverless steps (Inngest, Temporal) | Best of both, durable | Vendor dep |

**For most agentic systems:** workflow engine + serverless. Each step is short (single LLM call); overall workflow is long. Inngest/Temporal handle the durability; Lambda/Vercel handle the compute.

## 4.2 Streaming vs batch

| Pattern | Use when |
|---|---|
| Real-time streaming | User-facing chat, live monitoring |
| Near-real-time (1-5 min) | Most agent workflows: signal in, decision in minutes |
| Batch (hourly, daily) | Reports, summaries, low-priority enrichment |

Most "agentic systems" interview questions land in the near-real-time tier. Don't over-engineer for sub-second latency unless the prompt demands it.

## 4.3 Embedding pipelines

**Two flavors:**
- **Inline:** signal arrives → embed inline → write embedding with row.
- **Async:** signal arrives → enqueue embedding job → embedding written later.

Inline is simpler but adds latency to ingest. Async is more complex but ingest stays fast. For most systems, inline is fine until embedding latency becomes a bottleneck.

**Embedding cost tip:** cache by content hash. If the same text shows up twice, don't re-embed.

---

# Part 5. Cross-cutting failure modes

| Failure | Mitigation pattern |
|---|---|
| LLM provider rate limit | Token bucket + provider rotation + backoff with jitter |
| LLM provider outage | Circuit breaker + fallback provider + queue for retry |
| LLM hallucination | Constrain via tool schemas, validate outputs, critic agent |
| Agent infinite loop | Max iterations, max wall time, max token budget per run |
| Concurrent writes to same entity | Content-addressed dedup OR optimistic concurrency |
| Retry after partial side effect | Idempotency keys + durable step checkpointing |
| Slow downstream tool | Per-tool timeout, circuit breaker, fallback |
| Cost overrun on a runaway tenant | Per-tenant quota with hard cutoff + alert |
| Bad data poisons embeddings | Validation at ingest, content moderation pre-embed |
| Vector index degrades over time | Re-index periodically, monitor recall metrics |
| Cold start kills cron tick | Keepalive ping, longer webhook timeout, retry policy |
| Schema migration breaks running agents | Versioned tool schemas, agents target a schema version |

---

# Part 6. Cost optimization

Real interviewers care that you can do back-of-envelope cost math. Practice this.

**Scenario:** 1000 tenants, 50 signals/day each, average agent run uses 8k input tokens + 1k output tokens, GPT-4o.

- Daily signals: 1000 x 50 = 50k
- Daily agent runs (assume 1.5 per signal): 75k
- Input tokens/day: 75k x 8k = 600M
- Output tokens/day: 75k x 1k = 75M
- Input cost (uncached): 600M / 1M x $2.50 = $1500/day
- Output cost: 75M / 1M x $10 = $750/day
- Total: $2250/day = ~$67k/month uncached

With 90% prefix caching:
- Cached input: 540M x $0.25 = $135/day
- Uncached input: 60M x $2.50 = $150/day
- Output unchanged: $750/day
- New total: $1035/day = ~$31k/month

Caching saved ~$36k/month. The math is the senior move.

**Other levers:**
- Cheaper model for the routing/dispatch step (Haiku, GPT-4o-mini)
- Truncate prompts: only include facts above relevance threshold
- Batch embedding requests
- Move read-heavy projections to materialized views (DB cost down, latency down)

---

# Part 7. How to walk into the interview

The 45-minute structure most interviewers use:

```
0-5 min     Clarify requirements
5-15 min    High-level architecture
15-30 min   Deep dive on 2-3 components
30-40 min   Scaling, failure modes, follow-ups
40-45 min   Trade-offs, what you'd do differently
```

**Step-by-step playbook:**

### Step 1. Clarify (don't skip this)

Ask about:
- Scale: tenants, events/day, latency requirements
- Read vs write ratio
- Consistency tolerance: strict / eventual / session
- Constraints: language, cloud, budget
- Out of scope: what NOT to design

The interviewer expects this. Skipping it is a junior move.

### Step 2. Sketch the seven layers (Part 1)

Draw the box diagram. Don't optimize yet. Just say "input layer here, ingest here, routing here..." and label what each does.

### Step 3. Pick 2-3 components to deep dive

The interviewer will guide you. Common targets:
- The routing/predicate layer (subscriptions)
- The agent runtime + state machine
- The storage model
- The failure handling

Use the patterns from Part 2 and the trade-offs from Part 3-4.

### Step 4. Numbers

Pull out a back-of-envelope calc when relevant. Token cost. QPS. Storage estimate. Even rough numbers signal seniority.

### Step 5. Trade-offs

For every design decision, name the alternative and why you didn't pick it. "I'd use Postgres event log here. Could also use Kafka. Postgres is fine until we hit ~10k events/sec. We're at 100/sec, no need to add a second system."

### Step 6. Failure modes

Volunteer two or three failure modes before they ask. "If the LLM provider rate limits us, here's the queue and backoff..."

### Step 7. What you'd build differently at scale

Senior closer. "If this needed to handle 100x more, I'd split events to Kafka, move embeddings to dedicated Pinecone, tier cold events to S3, and add a per-tenant cost gate."

**Senior-level moves to memorize:**
- Volunteer trade-offs without being asked
- Quote real cost numbers
- Identify the bottleneck before the interviewer does
- Surface open questions that depend on requirements you don't yet know
- Reference real systems by name (Datomic for event sourcing, Riak for vector clocks, Cursor's architecture for agent loops)

**Junior moves to avoid:**
- Jumping to implementation before clarifying requirements
- Picking a tool because you've used it ("I'd use Mongo because I know it")
- Ignoring failure modes
- Designing for hypothetical scale ("but what about 1B users")
- Mocking the interviewer's question

---

# Part 8. Practice questions

Drill these out loud. For each, sketch the seven layers, pick 2 to deep dive, and finish with trade-offs + scaling.

### Easy / warm-up
1. **Design an autonomous email triage agent.** Inbox → categorize → archive / snooze / reply.
2. **Design a code review bot.** PR opens → bot reviews → comments + summary.
3. **Design a meeting notes agent.** Calendar → join call → transcribe → extract action items → distribute.

### Medium
4. **Design an outbound sales agent system.** Discover prospects → enrich → score → draft email → send → track replies.
5. **Design ChatGPT memory.** Cross-session memory that learns user preferences without leaking facts across users.
6. **Design Cursor's agent mode.** User prompt → plan → edit files → run tests → iterate.
7. **Design a deep research agent.** Question → decompose → web search → read → synthesize → cite.
8. **Design an autonomous customer support tier-1 agent.** Ticket arrives → route or answer → escalate if stuck.
9. **Design a CRM for AI agents** (this codebase). Many agents writing concurrently to shared records, with replay and provenance.

### Hard
10. **Design a system to coordinate 1000 sub-agents on a single task.** Decomposition, communication, deduplication of work, conflict resolution.
11. **Design an LLM-based monitoring system for a microservices fleet.** Log streams + alerts → triage agent → root cause hypothesis → page humans on confirmed incidents.
12. **Design a self-improving agent.** Logs its own failures, generates training data, retrains its own prompts or fine-tunes a base model.
13. **Design an agentic IDE.** Multiple agents (test runner, refactorer, type-fixer, doc writer) collaborating on a codebase without stomping each other.
14. **Design Claude Code / Aider.** Conversational coding agent with tool use, file editing, durable session, context management across long sessions.

### Curveballs
15. **Design a system where agents bid for tasks.** Internal market, price discovery, fraud prevention.
16. **Design an agentic system that manages other agents.** A meta-agent that hires, fires, and tunes worker agents.
17. **Design an agent that operates with strict differential privacy guarantees.** Hospital data, can't leak across patients.

For each, the framework: clarify scale + constraints, lay out 7 layers, pick two for deep dive, name trade-offs, walk failure modes, give back-of-envelope cost.

---

# Part 9. Reference architectures (worked examples)

Brief sketches of how to answer the most common prompts. Use these as templates, not memorize-and-regurgitate.

## 9.1 Design an outbound sales agent system

**Layers:**
1. **Trigger:** cron (every hour) + webhook ingestion (CRM updates).
2. **Ingest:** scrape job boards, news APIs, social signals; normalize to a common signal schema.
3. **Routing:** subscriptions on `industry`, `funding_stage`, `keywords`. Embedding similarity to ICP description.
4. **Agent:** enricher (extract facts from signal), scorer (ICP fit), drafter (compose email).
5. **Action:** send email via SendGrid, log to CRM, schedule follow-up.
6. **State:** events table for audit, facts table for entity profile, drafts table for review queue.
7. **Gates:** drafter posts to a review queue; humans approve before send (tunable: auto-send if confidence > 0.9).

**Key trade-offs:**
- Buy vs build the prospect database: buy from Apollo/PDL/Hunter; building from scratch wastes a year.
- Auto-send vs always-gate: gate by default, auto-send only on high-confidence + low-risk segments.
- Embedding update cadence: re-embed prospects on significant fact change, not on every change.

**Scaling:** 1000 prospects/day baseline. Embedding cost dominates if you re-embed everything. Cache by entity + version.

## 9.2 Design Cursor's agent mode

**Layers:**
1. **Trigger:** user prompt in chat.
2. **Ingest:** parse prompt, locate referenced files, build initial context.
3. **Routing:** internal: dispatch to "plan" agent first, then "edit" agent, then "verify" agent.
4. **Agent:** state machine with bounded iterations. Plan → edit → run tests → fix or finish.
5. **Action:** edit files (via apply_patch tool), run shell commands, query LSP.
6. **State:** session-scoped. Conversation history, edited files set, test results. Persists across user turns.
7. **Gates:** show diff before applying for unsafe changes (deletes, schema changes).

**Key trade-offs:**
- Plan-first vs react-first: plan-first is slower but more reliable; reactive is faster on small tasks. Tune by task complexity heuristic.
- Tool granularity: one big "execute" tool vs many specific tools. Specific tools constrain behavior; one big tool maximizes flexibility but increases hallucination risk.
- Context window strategy: prune aggressively, summarize old turns, keep tool schemas in cached prefix.

**Failure modes:**
- Agent edits same file repeatedly (loop). Detect via diff stagnation; abort.
- Agent breaks tests by editing the wrong file. Verify step + rollback to last-known-good.
- User context window full. Summarize aggressively or split sessions.

## 9.3 Design ChatGPT memory

**Layers:**
1. **Trigger:** every user turn.
2. **Ingest:** the agent decides if a turn contains a memorable fact ("I'm vegetarian"). If yes, calls `save_memory(text)`.
3. **Routing:** memories are scoped to user_id only.
4. **Agent:** every new conversation, retrieve top-K memories by embedding similarity to the current message, inject into system prompt.
5. **Action:** read memories, write memories, delete on user request.
6. **State:** per-user memory store. Embeddings + raw text. Probably Postgres + pgvector.
7. **Gates:** user can view, edit, delete any memory. UI surface for transparency.

**Key trade-offs:**
- What to remember: model decides vs explicit rules. Both: explicit rules for high-value (allergies, preferences), model judgment for the rest.
- Memory limits: max N memories per user. Force compression / forgetting at the limit.
- Privacy: memories must not leak across users. Tenant isolation by user_id at every layer.

**Scaling:** 100M users x 100 memories x 1536 dims = ~60GB just vectors. Shard by user_id hash.

## 9.4 Design a deep research agent

**Layers:**
1. **Trigger:** user research question.
2. **Ingest:** decompose question into sub-questions (planner agent).
3. **Routing:** dispatch each sub-question to a researcher agent.
4. **Agent:** researcher loop: web search → read → take notes → decide if enough info → return notes. Synthesizer agent at the end combines.
5. **Action:** call search APIs (Tavily, Exa, Perplexity API), fetch URLs, read docs, save notes.
6. **State:** research session document. Sub-questions, sources, quotes, draft answer. Shared between researcher agents and synthesizer.
7. **Gates:** none usually. User reviews final output.

**Key trade-offs:**
- Depth vs breadth: width-first explores many sources shallowly; depth-first goes deep on one. Most systems do both with a budget.
- Source credibility: trust score per domain, weight quotes by trust, surface conflicts.
- Citation discipline: every claim in the final answer must cite a source it actually read. Enforce in the synthesizer prompt and validate post-hoc.

**Failure modes:**
- Hallucinated citations. Validate URL + quote actually appears in the source.
- Loops on contradictory info. Bound iteration; surface the contradiction to user.
- Cost runaway. Per-research-task token budget; cut off when exceeded.

## 9.5 Design a system to coordinate 1000 sub-agents

**Layers:**
1. **Trigger:** top-level task arrives.
2. **Ingest:** orchestrator decomposes into N sub-tasks.
3. **Routing:** task queue. Sub-agents pull from queue. Affinity rules (skill-based routing).
4. **Agent:** sub-agents are mostly identical workers; orchestrator is the brain.
5. **Action:** sub-agents emit work products. Orchestrator merges.
6. **State:** event-sourced. Each agent writes events; the global state is replayable.
7. **Gates:** orchestrator approves merges; humans approve only the final synthesis.

**Key trade-offs:**
- Stateless workers vs stateful workers: stateless is easier to scale, scheduling is simpler. Stateful has lower latency for follow-up tasks. Use stateless unless follow-ups dominate.
- Coordination via queue vs gossip: queue is centralized, gossip is decentralized. Queue is simpler at this scale.
- Conflict resolution: two sub-agents produce conflicting results. Vote, weighted average, or escalate to orchestrator.

**Scaling:** 1000 agents at 1 task/sec each = 1000 QPS to the queue. Redis Streams or Kafka. Backpressure via consumer lag monitoring.

---

# Appendix: vocabulary you should be fluent in

These come up in every agentic system design conversation:

- **Idempotency** vs **exactly-once delivery** (the latter is a myth; you want the former)
- **Eventual consistency** vs **strong consistency** vs **session consistency**
- **CAP theorem** (pick two; agentic systems usually pick AP with eventual consistency)
- **Saga pattern** (long-running transactions split into compensable steps)
- **Outbox pattern** (write to DB and publish to queue atomically)
- **CQRS** (Command Query Responsibility Segregation: writes go one way, reads read from a projection)
- **Event sourcing** (state from log)
- **Materialized view** (precomputed projection)
- **Backpressure** (slow down producers when consumers can't keep up)
- **Circuit breaker** (stop hitting a failing dependency)
- **Bulkhead** (isolate failures so one bad tenant doesn't kill others)
- **Rate limit token bucket** vs **leaky bucket** (the former allows bursts, the latter smooths)
- **Vector clock** vs **Lamport timestamp** (causal ordering in distributed systems)
- **Read replica** vs **standby** (one serves reads, the other waits to fail over)
- **Consistent hashing** (sharding that minimizes data movement on resize)
- **Hot key** (one shard takes disproportionate traffic)
- **Tail latency** (p99, p999; the long tail kills user experience)
- **Cold start** (first request after idle; serverless and ML model loading)
- **Prompt caching** (provider-side caching of repeated prefixes)
- **Tool use / function calling** (agent calling typed APIs)
- **MCP** (Model Context Protocol; standard for tool servers)
- **HNSW** vs **IVF** (vector index types; HNSW for low recall flexibility, IVF for huge scale)
- **Embeddings drift** (model updates change embedding meaning; re-embed periodically)
- **Eval pipeline** (continuous quality measurement of agent outputs)
- **LLM-as-judge** (using one LLM to score another's output; standard for production eval)

If any of these terms are fuzzy, look them up before the interview.

---

# Final note

The patterns matter more than the specific implementation. An interviewer doesn't care if you used Inngest vs Temporal. They care that you knew the trade-offs, knew when to reach for durable execution, and knew what to do when it failed.

Walk in with the seven-layer framework, the pattern catalog, the cost math, and the failure modes. Everything else is detail you adapt to the prompt.
