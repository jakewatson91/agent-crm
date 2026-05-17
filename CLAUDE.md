# Project: agent-crm

## Context

Building an agent-native CRM. Spun out of the sim-ai case study (see `reference/sim_gtm_summary.md`) once it became clear the case-study work didn't have a wedge as a product, but the underlying question — "what does a system of record built for agents actually look like?" — does.

## Thesis

**The primary user is the agent. Humans are involved only when needed.**

Humans show up to: (a) join calls (which are recorded and transcribed anyway), (b) ask questions of the data, (c) intervene at approval gates. Otherwise the system is in a format AI consumes and acts on most efficiently.

Wedge is **interface-as-category**, not algorithm. The substrate is commodity (Postgres + pgvector + S3); the abstraction layer above it is what makes the system agent-native — provenance-bearing reads, tool-call writes, event-sourced consistency, content-addressed facts, pub/sub on predicates, semantic subscriptions, memory hierarchy.

## Hard rule: agent-first or it doesn't ship

**Every feature must answer: does this make the agent more efficient, or does it just make a dashboard?** If it's the second, do not build it. We lose the wedge the moment we copy Day/Rox/HubSpot patterns.

**Allowed human surfaces, by purpose only:**
- **Gates** — approval inbox for irreversible actions. Empty when healthy.
- **Audit / debug** — thin views to verify what the agent saw and decided. Provenance walks, replay, raw event log. Explicitly framed as audit, not as a "view" of the CRM.
- **Configuration** — set constitution, KB, sources, agents. One-time-ish setup, not daily use.

**Banned patterns:**
- Pipeline / kanban / stage-tracking views ("here's everything in Outreach Sent stage")
- Drag-to-reorder, batch operations, multi-select, "select all and..."
- Sortable / filterable tables of entities for human triage
- Any UI where the human is the loop instead of the auditor
- "Notification feed for the user" — notifications go to gates or external channels (Slack, email), not in-app feeds for browsing

**The agent-first version of every feature:**
- Before building a UI, ask: what's the MCP tool / API endpoint that lets an agent do this same thing programmatically? Build that first. The UI is a thin debugging shell over the agent surface.
- Reads are token-efficient projections, not full row dumps.
- Writes are tool calls with validation + audit, never raw SQL from the UI.

When in doubt: build the agent capability first, audit surface second, never a "human dashboard."

## Portability test

Before merging any new feature, answer: *can a customer enable / configure / disable this via workspace settings, without a code change?*

If no, restructure. The thing must either be:
- a substrate primitive (events / facts / gates / scoring framework / dispatcher) — fine to be code, same for every customer
- or a config knob — must live on `workspaces.policy` (or `sources.config` if it's a connector setting)

Specific bans:
- No hardcoded values that vary by customer (email addresses, brand names, banned phrases, scoring thresholds, vertical-specific defaults).
- No new env vars for behavior toggles (only API keys / secrets are env-acceptable).
- Wizard / settings defaults must be vertical-neutral. "B2B SaaS" is not a default; "no default" is the default.

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
- **Test case (dogfood):** Use agent-crm to sell agent-crm itself. Target = startups that want to run sales with ≤1 salesperson and would buy an agent to do outbound for them. Every example, flow, pitch, and diagram in this project should use THIS as the running scenario. Do NOT default to Jake's job hunt — that framing is dead.
- **Buyer profile:** solo / pre-sales-hire founder. Has 5 minutes a day for sales. Wants the agent to do the work end-to-end and to be auditable when it screws up.
- **Storage v0:** SQLite + MD files with YAML frontmatter (Obsidian readable). Move to Postgres at design partner.
- **Don't pre-build:** multi-tenant, Kafka, vector DB partitioning. All defer to when volume forces them.

## Open questions

1. TAM at the sharp end (buyer = ops teams >1K autonomous touches/month, ~2K companies today).
2. Multi-tenant vs single-tenant embeddings (network effect vs privacy).
3. Where Sim plugs in (MCP action layer = partnership angle).
4. Whether Moltbook's feed/thread form factor transfers to B2B.
