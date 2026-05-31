# agent-crm — system design overview

Study doc for system design interviews. Covers the architecture, the key trade-offs, the "why X over Y" decisions, and the failure modes. Built around the actual implementation but written so it's interview-defensible.

---

## 1. The core idea

A CRM where the **primary user is an agent**, not a human. Humans show up at gates: approval points, questions of the data, joining calls. The rest of the time the system runs on its own.

Wedge is the **abstraction layer**. The substrate (Postgres + pgvector + RLS + S3) is commodity. The interesting layer is what sits above it:
- Provenance-bearing reads
- Tool-call writes
- Event-sourced consistency
- Content-addressed facts
- Pub/sub on predicates
- Memory hierarchy

Three numbers worth memorizing for the pitch:
- **2.6× cheaper per agent action vs HubSpot** (5× vs Day.ai, 5.8× vs Attio; tied with Twenty). Measured in `benchmark/v1`, reproducible via `pnpm benchmark:v1:audit`
- **96% data loss in HubSpot** under concurrent writes (we lose 0%)
- **~91% prompt cache hit rate** on agent-run prefixes

---

## 2. The high-level diagram

```
                       ┌─────────────────────────────┐
                       │    External world           │
                       │    (HN, YC, Exa, RSS, PH,   │
                       │     GitHub, web scraping)   │
                       └──────────────┬──────────────┘
                                      │  HTTP fetch / API calls
                                      ▼
              ┌─────────────────────────────────────────────┐
              │  Inngest cloud  (workflow engine)            │
              │   - cron timer (0 * * * *)                   │
              │   - durable step queue                       │
              │   - retries + concurrency keys + replay      │
              └──────────────┬──────────────────────────────┘
                             │  signed POST/PUT /api/inngest
                             ▼
              ┌─────────────────────────────────────────────┐
              │  Render (Next.js 15 app, Node runtime)       │
              │  ┌───────────────────────────────────────┐   │
              │  │  /api/inngest  (serve handler)         │   │
              │  │   - sourceDispatcher  (cron fan-out)   │   │
              │  │   - sourceRun        (connector exec)  │   │
              │  │   - matchSignal      (signal → subs)   │   │
              │  │   - onSubscriptionMatched (→ agent.run)│   │
              │  │   - agentRun        (LLM loop + tools) │   │
              │  │   - notifyOnGate    (human approval)   │   │
              │  └───────────────────────────────────────┘   │
              │  ┌───────────────────────────────────────┐   │
              │  │  Dashboard pages (server components)   │   │
              │  │   /gates  /channels  /entities         │   │
              │  │   "Why this?" replay popover           │   │
              │  └───────────────────────────────────────┘   │
              └──────────────┬──────────────┬───────────────┘
                             │              │
                  reads/writes via service role and RLS
                             │              │
                             ▼              ▼
              ┌─────────────────────────────────────────────┐
              │  Supabase (Postgres + pgvector + RLS)        │
              │                                              │
              │  EVENTS  (append-only, source of truth)      │
              │     │  pg_net trigger publishes signals/    │
              │     │  gates back to Inngest webhook         │
              │     ▼                                        │
              │  FACTS (content-addressed, supersede chain) │
              │  SIGNALS · ENTITIES · CLAIMS · CONTACTS      │
              │  SUBSCRIPTIONS (jsonb filter + vector(1536)) │
              │  CHANNELS · CHANNEL_POSTS                    │
              │  SOURCES (configured ingest)                 │
              │  WORKSPACES (multi-tenant)                   │
              └─────────────────────────────────────────────┘
                             ▲
                             │ LLM calls + embeddings
                             │
                       ┌─────┴─────┐
                       │  OpenAI   │
                       │  (chat,   │
                       │   embeds) │
                       └───────────┘
```

---

## 3. Component breakdown

### 3.1 Storage layer (Supabase Postgres)

Single Postgres database, multi-tenant by `workspace_id`. RLS policies enforce that workspace members only see their own data. Service role bypasses RLS for system writes (connectors, agents).

**Why one DB, not microservices?** A CRM is a join machine. Splitting `entities`, `signals`, and `events` into separate stores forces distributed joins, which forces a service mesh, which forces eventual consistency. Postgres + RLS gets us tenancy isolation, transactional joins, and one operational surface. Multi-tenant embeddings live in the same DB via `pgvector`.

**Why pgvector and not Pinecone/Weaviate?** The subscription match query is `WHERE structured_filter @> signal.tags AND embedding <-> signal.embedding < threshold`. Doing this across two stores means two round trips, two failure modes, no transactional guarantee that a subscription you read is the one that fired. Pgvector keeps it as one SQL statement against one connection.

**Trade-off accepted:** at >100k vectors per workspace, HNSW index quality may degrade. Open question I'd flag in the interview: at what scale does this break, and what's the migration path? Likely answer: shard by workspace once any single workspace passes ~50k vectors.

### 3.2 Workflow engine (Inngest)

Inngest is the durable execution layer. Each function in code becomes a registered handler in Inngest cloud. When an event fires, Inngest sends a signed HTTPS POST to `/api/inngest`. Each `step.run` block is checkpointed: if it fails, the next retry resumes from the last completed step. Concurrency keys throttle per-workspace to prevent one tenant from starving another.

**Why Inngest and not raw SQS/Kafka + workers?** SQS gives you "at least once," not "exactly once with checkpointing." Kafka gives you ordering but not durable function state. To get the same behavior we'd build: a queue, a poller, idempotency tracking, retry policies, dead-letter routing, an admin dashboard. Inngest is two npm imports. The total cost of switching off Inngest later is low because your functions are still just async TypeScript.

**Why not Temporal?** Temporal requires running workers continuously (Java/Go SDKs are first-class; TypeScript is second). Inngest is webhook-based, no long-running worker. Better fit for serverless / Render free tier.

### 3.3 Application + UI (Next.js 15 on Render)

One Next.js app does double duty:
- The dashboard pages (server components reading from Supabase via service role)
- The `/api/inngest` webhook handler (Inngest's `serve()` registers all functions)

**Why one app instead of separate API service?** Less ops surface, shared types between server components and Inngest functions, single deploy. Trade-off: long-running steps (>60s OpenAI calls in agent_logic) can hit serverless function timeouts on some platforms. Mitigated by `maxDuration = 300` (Vercel Pro) or by running on Render's container (no timeout).

### 3.4 Connectors (ingest)

Seven connectors: `yc`, `hn`, `exa`, `web` (RSS / scrape), `producthunt`, `github`, `api_call` (custom). Each implements `Connector.run({ supabase, workspace_id, source_id, config })` and emits signals via `callTool('create_signal', ...)`.

The `sourceDispatcher` cron (`0 * * * *`) reads active rows from the `sources` table and fans out one `source.run` event per source. Each `source.run` invokes the matching connector. Idempotency lives at the signal level: signals are deduplicated by `(workspace_id, signal_source, source_external_id)`.

**Why pull (cron) and not push (webhooks)?** Discovery sources (HN, YC, Reddit) don't expose webhooks. For tracking known entities (GitHub releases, PH launches by a watched maker) push would beat pull, but that's a different mode. Per-source `schedule_cron` is stored on the row but not yet enforced; v0 runs every active source on every hourly tick.

### 3.5 Subscriptions (the fan-out layer)

Subscriptions are predicates with two parts:
- `structured_filter` jsonb (e.g. `{"signal_source": "yc", "industry": "b2b_saas"}`)
- `semantic_query` text → `semantic_embedding vector(1536)`

When a signal arrives, `matchSignal` runs one SQL query:

```sql
SELECT id FROM subscriptions
WHERE structured_filter @> signal.tags         -- GIN index
  AND active = true
  AND 1 - (semantic_embedding <=> $signal_emb) >= threshold;  -- HNSW
```

For each match, fan out a `subscription.matched` event. If the subscription owner is an agent, dispatch `agent.run`. If the owner is a human, post to a channel.

**Why two filter dimensions and not just one?** Structured-only is brittle (hand-coded keyword rules age fast). Semantic-only is fuzzy (no way to say "only YC stuff"). Combining gives a hard precision floor (`signal_source: yc` skips everything else) plus soft recall (semantic threshold catches paraphrases).

### 3.6 Agent runtime

`agent_logic.ts` (1400 LOC) is the LLM loop. Three behaviors:
- **claim_poster** — reads facts, writes a `claim` post
- **drafter** — reads facts, writes a `touch_draft` post (draft outreach)
- **enricher** — reads a signal + entity, asserts atomic facts via `assert_fact`

Each invocation: load context (workspace constitution, KB, entity facts, signal), build prompt with cached prefix, call OpenAI, parse tool calls, dispatch via `callTool`. Prompt caching gets ~91% hit rate because the prefix (constitution + KB + tool schemas) is stable.

Order of operations is important: enricher → claim_poster → drafter. Drafters reason over facts that enrichers asserted. Suppression: before drafting, check for existing `touch_draft` in the channel within the last 7 days; if present, fire a gate instead of duplicating.

**Why OpenAI and not Anthropic?** Anthropic API account is blocked (per `project_state.md`); OpenAI is the working alternative. Architecture is provider-agnostic — swap the `chatComplete()` implementation in `@agent-crm/primitives`.

### 3.7 Events table (the source of truth)

```sql
CREATE TABLE events (
  id              bigserial PRIMARY KEY,
  workspace_id    uuid NOT NULL,
  ts              timestamptz NOT NULL DEFAULT now(),
  actor_kind      actor_kind NOT NULL,    -- 'agent' | 'user' | 'system'
  actor_id        text NOT NULL,
  action          text NOT NULL,          -- 'assert_fact' | 'create_signal' | ...
  target_id       uuid,
  payload         jsonb NOT NULL,
  parent_event_id bigint REFERENCES events(id),
  prompt_hash     text                    -- for replay
);
```

Append-only at the SQL grant level (no UPDATE/DELETE permission). Every state-changing operation produces an event. Tables like `facts`, `entities`, `claims` are projections — derived state you can rebuild from the event log.

`replay_to(workspace_id, ts)` is a Postgres function that reconstructs full state at a past timestamp. Used by the "Why this?" UI: opening a draft pops up the facts the agent saw at decision time, with cited facts highlighted.

---

## 4. Data flow: a single signal end-to-end

```
1. CRON TICK (Inngest, 0 * * * *)
        │
        ▼
2. sourceDispatcher  reads sources table, fans out source.run × N
        │
        ▼
3. sourceRun         calls connector (e.g. yc.run)
        │            connector inserts row in `signals` table
        │            DB trigger publishes signal.created event
        ▼
4. matchSignal       SQL: structured filter + vector cosine
        │            for each match: emit subscription.matched
        ▼
5. onSubscriptionMatched
        │            if owner_kind = agent: emit agent.run
        ▼
6. agentRun          loadContext → buildPrompt → openai.chat
        │            parse tool calls → callTool(...)
        │            tools: assert_fact, create_post, request_gate, ...
        │            each tool call writes an event row
        ▼
7. UI                /channels page reads channel_posts
                     "Why this?" popover calls replay_to(post.ts - 1ms)
```

Each numbered step is a durable Inngest function. If step 6 dies mid-LLM-call (timeout, OOM), Inngest retries from the last `step.run` checkpoint, not from step 1.

---

## 5. Key design decisions (interview gold)

These are the "why" answers an interviewer probes for.

### 5.1 Event sourcing over CRUD

**Decision:** all state changes are events; tables like `facts`/`entities` are projections.

**Why:** Three things become free that are otherwise expensive:
1. **Replay.** Audit any agent decision by replaying state to that timestamp. Without events, you'd need a separate audit log that drifts from reality.
2. **Provenance.** Every fact carries `source_event_id`. Click a sentence in a draft, walk back to the originating signal. Without events, this is a denormalized join nightmare.
3. **Concurrent writes.** Two agents asserting the same fact don't fight. They write two events; the projection deduplicates by `content_sha256`. Compare to row-locking CRMs where the second writer either blocks or stomps the first.

**Cost:** queries against current state need a projection layer. Read-amplification on hot rows. Mitigated by indexes + materialized views where it matters.

### 5.2 Content-addressed facts (sha256)

**Decision:** `fact_id = sha256(workspace_id || entity_id || predicate || object)`.

**Why:** Idempotent writes. Two agents asserting "Acme raised Series B from Sequoia" produce identical IDs. The second insert is a no-op. No row locks, no last-writer-wins.

**Cost:** facts can't be edited in place. To change an assertion, supersede the old fact with a new one (linked via `supersedes` column). Slightly more storage, much cleaner audit.

### 5.3 Single SQL for subscription matching

**Decision:** subscriptions live in Postgres with both jsonb filter (GIN index) and embedding (HNSW index).

**Why:** matching is one query, one connection, one transaction. No "the vector DB said 7 matches but the relational DB only confirms 5" inconsistency.

**Cost:** ties subscription scaling to Postgres. At ~100k+ vectors per workspace HNSW recall may suffer. Migration path: shard subscriptions by workspace into separate Postgres instances, or move to a dedicated vector store with workspace_id partitioning.

### 5.4 Inngest as durable runtime

**Decision:** workflow engine (Inngest cloud) handles cron, retries, fanout, concurrency keys. App code is plain TypeScript functions.

**Why:** durable execution is a hard problem. Building it in-house means a queue, a checkpointer, a dashboard, a retry policy, and a year of debugging. Inngest is `inngest.createFunction(...)` and you're done.

**Cost:** vendor dependency. The escape hatch is reasonable: Inngest functions are pure async TypeScript. If you ever needed to leave, you'd port to Temporal or roll your own around BullMQ. Not free, not catastrophic.

### 5.5 Agent writes go through tools, not raw SQL

**Decision:** agents call tools (`assert_fact`, `create_post`, `request_gate`); tools translate to events; events get projected.

**Why:** central choke point for validation, RLS, audit, rate limiting. An agent can't accidentally bypass the constitution check or the suppression window. Compare to "agents write to a generic SQL endpoint" where every agent has to remember every rule.

**Cost:** tool surface has to evolve as new behaviors arrive. New verbs need a new tool. So far 13 tools cover all behavior. If it grew to 50+ that's a smell.

### 5.6 Per-workspace concurrency keys

**Decision:** Inngest functions use `concurrency: { key: 'event.data.workspace_id' }`.

**Why:** one tenant running 100 agent.run events doesn't starve another tenant's two events. Fairness without queues-per-tenant.

**Cost:** tighter limits per workspace (5 on Inngest free, 50 on paid). Mitigation: scale paid plan when needed; structurally fine.

---

## 6. Failure modes and mitigations

| Failure | Mitigation |
|---|---|
| OpenAI rate limit during agent.run | Inngest retry with exponential backoff; durable step resume |
| Connector returns garbage (RSS HTML in title field) | Per-source extraction prompts (planned); validation at signal insert |
| Two agents write conflicting facts | Content-addressed fact_id; later one supersedes via explicit chain |
| Signal storm (1k events in 1 minute) | Per-workspace concurrency cap + Inngest's queue backpressure |
| Render service sleeps, cron misses tick | Keepalive ping (cron-job.org → / every 10 min); Inngest retries on cold start |
| Signing key mismatch between Inngest and Render | 401 surfaces in cron logs; rotate key |
| Postgres at high vector count (>100k) | Shard subscriptions per workspace; or move to dedicated vector DB |
| Drafter ignores constitution | Banned-phrase post-processor; gate on policy_violation; constitution loaded into cached prompt prefix |

---

## 7. What I would build differently at scale

If this needed to handle 10k workspaces and 100M signals/month:

1. **Split the events stream.** Move `events` to Kafka or a managed equivalent. Postgres becomes the projection layer only. Today's pg_net trigger to webhook is fine for v0; doesn't survive at volume.
2. **Tiered storage.** Cold events (older than 90 days) move to S3 with Iceberg/Parquet. Replay queries hit warm + cold paths.
3. **Per-workspace embedding index.** Today: one global HNSW per workspace_id partition. At scale: dedicated vector DB (Qdrant or Pinecone) with workspace partitioning, kept consistent with Postgres via outbox pattern.
4. **Memory hierarchy on agent prompts.** Today everything goes in the prompt prefix. At scale: L1 (current run) → L2 (cached vector retrieval) → L3 (warm embedding store) → L4 (cold S3 history). Pulled in only when relevance > threshold.
5. **Real multi-region.** Read replicas per region, writes to primary, ascending-bigserial events guaranteed monotonic. Today single-region is fine.

---

## 8. Open questions I'd flag in the interview

These are the parts that aren't decided. Surfacing them is the senior move.

1. **Multi-tenant embeddings with cross-tenant network effects.** "Companies similar to Acme" wants embeddings shared across tenants. But sharing breaks privacy. Current answer: workspace-isolated embeddings; revisit when a customer asks.
2. **Memory hierarchy.** Today the agent prompt holds the full constitution + KB + active facts. At what point does that become the bottleneck? Cost-driven, not architecture-driven — let it emerge.
3. **MCP as the action layer.** Long-term bet: agents talk to external systems (email, calendar, Salesforce) via MCP, not bespoke integrations. Today bespoke; tomorrow MCP. Migration is per-tool.
4. **TAM at the sharp end.** Who actually has >1k autonomous touches per month and can't get there with HubSpot + a lot of duct tape? Estimated ~2k companies in 2026. Not a system design question but informs whether to invest in scaling above the v0 substrate.

---

## 9. The 60-second elevator answer

> "agent-crm is an event-sourced CRM where agents are the primary user. Every state change is an event in Postgres. Facts are content-addressed by sha256 so concurrent writes are idempotent. Subscriptions are predicates with both a jsonb filter and a 1536-dim embedding, matched in one SQL query against pgvector. Inngest is the durable runtime — cron fires hourly, fans out per-source events, signal-created triggers the matcher, matched subscriptions dispatch agent runs. Each agent invocation goes through a tool surface for validation and audit. The dashboard's `Why this?` view uses `replay_to(timestamp)` to reconstruct what the agent saw at decision time. Architecture is the moat: the substrate is commodity, the abstraction layer is the product."
