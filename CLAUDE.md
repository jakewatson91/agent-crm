# Project: agent-crm

## Context

Building an agent-native CRM. Spun out of the sim-ai case study (see `reference/sim_gtm_summary.md`) once it became clear the case-study work didn't have a wedge as a product, but the underlying question — "what does a system of record built for agents actually look like?" — does.

## Thesis

**The primary user is the agent. Humans are involved only when needed.**

Humans show up to: (a) join calls (which are recorded and transcribed anyway), (b) ask questions of the data, (c) intervene at approval gates. Otherwise the system is in a format AI consumes and acts on most efficiently.

Wedge is **interface-as-category**, not algorithm. The substrate is commodity (Postgres + pgvector + S3); the abstraction layer above it is what makes the system agent-native — provenance-bearing reads, tool-call writes, event-sourced consistency, content-addressed facts, pub/sub on predicates, semantic subscriptions, memory hierarchy.

## Competition (snapshot, May 2026)

- **Rox** ($1.2B valuation) — Agent Swarm on top of Salesforce/HubSpot. Reactive monitoring, not proactive.
- **Day.ai** ($20M Sequoia) — Replacement CRM that auto-populates from email/meetings. Capture-focused; no event-sourcing or provenance discipline.
- **Attio** — API-first modern CRM, adding agent features.
- **Salesforce Agentforce / HubSpot Breeze** — incumbents racing to retrofit.

Gap: nobody has built the *substrate* for agents to operate on. Everyone has built better dashboards.

## Key files

- `brainstorm/session-001-product-thesis.md` — origin session, why we landed here, validation plan
- `architecture/entity-model.md` — 10 core entities, 5 interaction primitives, load-bearing principles
- `architecture/abstraction-layer.md` — substrate vs layer, why "tables with embeddings" isn't enough
- `reference/sim_gtm_summary.md` — original Sim case study GTM framework (context only)
- `reference/sim-pipeline/` — sim-ai pipeline code (patterns, not architecture)
- `reference/sim-prompts/` — system prompts from sim-ai
- `reference/sim-config/` — yaml configs from sim-ai

## Working assumptions

- **Year:** 2026.
- **Validation order:** dog-food on Jake's job hunt → public-data testbed (GitHub/HN/YC/SEC) → one design partner.
- **Storage v0:** SQLite + MD files with YAML frontmatter (Obsidian readable). Move to Postgres at design partner.
- **Don't pre-build:** multi-tenant, Kafka, vector DB partitioning. All defer to when volume forces them.

## Open questions

1. TAM at the sharp end (buyer = ops teams >1K autonomous touches/month, ~2K companies today).
2. Multi-tenant vs single-tenant embeddings (network effect vs privacy).
3. Where Sim plugs in (MCP action layer = partnership angle).
4. Whether Moltbook's feed/thread form factor transfers to B2B.
