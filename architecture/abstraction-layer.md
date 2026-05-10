# Abstraction Layer

Status: Draft, from session 001.

## The thing that's not "just tables with embeddings"

Postgres + pgvector is the substrate. There is no exotic agent-native database that beats it as raw storage. Datadog, Snowflake, Notion all sit on commodity DBs — value is never the substrate.

The wedge is the abstraction layer above the substrate. This is where it's genuinely different from Rox / Day / Attio / Salesforce.

## What's different about how an agent reads/writes

| Humans | Agents |
|---|---|
| Browse hierarchies (folders, tabs) | Query semantically across everything |
| Read documents whole | Read fragments with provenance |
| Type into forms | Compose tool calls |
| Need consistent UI state | Need replayability + audit |
| One thing at a time | Many things in parallel |

CRMs are built for the left column. The abstraction layer here is built for the right.

## Substrate vs layer

```
┌──────────────────────────────────────────────────┐
│  Interface: feed + threads + gates + query      │  ← humans see this
├──────────────────────────────────────────────────┤
│  Primitives: query / subscribe / act / gate /   │
│  cite (5 functions, used by humans AND agents)  │
├──────────────────────────────────────────────────┤
│  Abstraction layer:                              │  ← this is the wedge
│  - tool-call write API (MCP-shaped)              │
│  - provenance-bearing read projections           │
│  - event-sourced consistency                     │
│  - content-addressed facts                       │
│  - pub/sub on predicates                         │
│  - cost-aware retrieval                          │
│  - memory hierarchy (L1 prompt → L4 cold)        │
├──────────────────────────────────────────────────┤
│  Substrate: Postgres + pgvector + S3 + Redis    │  ← commodity, swappable
└──────────────────────────────────────────────────┘
```

If the abstraction layer is right, the substrate is swappable later (Postgres → graph DB → streaming → whatever) without breaking agents. If it's wrong, you've built another CRM.

## Not what CRMs do

Rox is "agents on top of Salesforce" — same substrate, same abstraction, AI bolted on top.

Day is "Postgres + AI summaries of email" — same substrate, different surface, no event-sourcing or provenance discipline.

Salesforce/HubSpot are mutable rows + foreign keys + UIs designed for typing. Retrofitting them with agent semantics breaks everything they've built.

The reason is they were built for humans to type into forms. Agents need a fundamentally different consistency model (event-sourced, provenance-bearing, content-addressed). Can't get there from the existing substrate without ripping the abstraction layer out and starting over.

## More radical substrate options (worth knowing exist)

Skipping for v1, but tracking:

- **Knowledge graph + vectors** (Neo4j with vector indexes, LanceDB with graph). Triples + embeddings. Genuinely different topology. Right shape if entity *relationships* matter more than entity *attributes* long-term.
- **Streaming-first** (Materialize, RisingWave). Subscription is native; queries are continuous. Closer to right access pattern if we commit hard to push-based agents.
- **Content-addressed DBs** (Dolt, TerminusDB). Git semantics for data — branch, merge, diff. Real but immature.
- **Pure vector stores with no rows.** Schema implicit in embedding model. No symbolic anchor → no audit story. Research-grade, don't ship on this.

## Storage substrate (v0)

Picked by access pattern, not by ideology.

| Data | Format | Why |
|---|---|---|
| Entities (accounts, contacts) | Postgres rows + pgvector | Joins, transactions, vector search |
| Facts | Postgres rows | Atomic, queryable, supersession needs SQL |
| Events (append log) | Postgres append-only table | Sequenced writes, replay; Kafka if scale demands |
| Signals + embeddings | Postgres + pgvector | Vector search is primary access |
| Conversation transcripts | Postgres jsonb | Speaker-tagged segments, queryable |
| Audio/video | S3 / object store | Big, rarely re-read, pointer in DB |
| Projections | Redis or Postgres MV | Cache-on-read, invalidate on relevant event |

Dog-food phase: SQLite + MD files with YAML frontmatter (Obsidian readable). Move to Postgres at design partner.

## Size math (rough)

Per entity (multi-perspective embeddings): ~35 KB
Per signal: ~8 KB
Per call: ~115 KB DB + 30 MB S3

| Scale | DB | S3 |
|---|---|---|
| Job hunt (500 entities) | 60 MB | 1.5 GB |
| Public testbed (10K) | 4.4 GB | 0 |
| Design partner (50K) | 17 GB | 150 GB |
| Mid-market customer (200K) | 85 GB | 1.5 TB |
| Multi-tenant @ 100 customers | 9 TB | 150 TB |

Real limits: pgvector HNSW degrades around 10M vectors per index (mitigation: partition by tenant/type/time). Re-embedding cost when iterating perspective model is the actual recurring bill — budget for it.

Won't run into substrate size limits before 8-figure ARR. The limits we'll actually hit are (a) pgvector index quality past a few million vectors per index, and (b) re-embedding cost when iterating.
