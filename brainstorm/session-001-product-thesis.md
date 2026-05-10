# Session 001 — Product Thesis

Date: 2026-05-08
Context: Brainstorm spun out of the sim-ai case-study work. Question on the table: turn it into a real product?

## What we considered and rejected

**Turn the Sim outbound engine into a product as-is.**
Killed. The "artifact-as-cold-touch" angle (sending a working prototype instead of an email) is genuinely different from Clay/Apollo/11x, but it only works if you have a target product to scaffold *into*. For Sim, that's a Mothership prompt. For a horizontal product, you'd need a per-vertical generator (n8n flows, Zapier, HubSpot sequences). That's the real build, not the pipeline. Without it, this collapses into another bandit-driven outbound tool.

**Embeddings + Thompson sampling as the wedge.**
Killed. Three reasons:
1. **Replicable in a quarter.** Cosine-to-corpus + bandits is `sentence-transformers` + textbook implementation. Clay/Apollo/Common Room could ship as a feature. Algorithmic cleverness rarely wedges in GTM.
2. **Invisible to buyers.** Heads of sales buy meetings, pipeline, replies — not "deterministic embedding scoring."
3. **Volume mismatch.** Bandits across 9 experiments × arms × segments need thousands of touches per cell. SMBs don't have it; enterprises with it have a data team that resists black boxes. ICP for "I care about Thompson sampling" is maybe 50-200 companies globally.

Thompson stays in the demo for the case study (the prompt explicitly asks for "scientific approach: hypothesis → measurable test → kill/scale criteria" — bandits are literally that). But cut to 2 wired experiments, demote the rest. It's infrastructure, not headline.

## What we landed on

**Agent-native CRM** — primary user is the agent, humans involved only when needed. Joins calls (recorded anyway), asks questions of the data, intervenes at gates. Otherwise the system is in a format AI can consume and interact with most efficiently.

### Why now

Existing CRMs treat agents as bolt-ons. Agents have to scrape UIs, fight permission models built for humans, and write into schemas designed for manual data entry. The discontinuity (agents as primary actors) creates a wedge for a new system of record — same way Salesforce won by being SaaS-native vs Siebel, same way Attio is winning by being API-native vs Salesforce.

### Real competition

- **Rox** ($1.2B valuation, March 2026, founder Ishan Mukherjee) — Agent Swarm on top of Salesforce/HubSpot. One agent per customer account, paired with the AE. Three agent types: account monitoring, prospecting, CRM enrichment. Reactive capture. Sits *on top of* existing CRMs.
- **Day.ai** ($20M Sequoia 2025, founders O'Donnell + Pici, ex-HubSpot) — Replacement CRM. Connects to Gmail/Calendar/M365, auto-populates from email + meetings. AI joins meetings, transcribes, extracts. Conversational query. Core thesis: kill manual data entry.
- **Attio** — API-first modern CRM, well-funded, adding agent features.
- **Salesforce Agentforce / HubSpot Breeze** — incumbents racing to retrofit.

### What's actually open

Both Rox and Day are *capture* systems — they make existing GTM data better. Neither has experiments, arms, posteriors, provenance chains, or event-sourcing as first-class. Neither models agent-to-agent communication. Day's data model is conversation→entity. Rox's data model is account→agent.

Nobody has built the *substrate* for agents to operate on. They've built better dashboards.

## The Moltbook reframe

Moltbook (Schlicht, launched Jan 2026, acquired by Meta March 2026) is Reddit-for-AI-agents. The form factor — feed of agent posts, threaded replies, semantic subscriptions — solves three things no existing CRM solves:

1. **Interface for "what are my agents doing across 5K accounts."** Dashboards are stale, logs are unreadable. A scrollable feed filtered by account/segment/signal type is genuinely better. You scroll your outbound the way you scroll X.
2. **Agent-to-agent communication as first-class.** Today agents talk through pipelines or shared DB state. A feed-with-threads lets agents *cite* each other: scorer says X, classifier disagrees citing Y, resolution agent decides. Composable and auditable.
3. **Embeddings finally have an interface job.** Subscriptions aren't to topic strings — they're to vectors. "Subscribe to anything that smells like 'evaluating agent infra at >50 employees.'"

### Where Moltbook's model breaks for B2B

- **"Humans observe, agents post" inverts in B2B.** Human is the *buyer* of the tool — they need to intervene at gates, redirect, approve sends. Model has to be: humans and agents both post, agents do 95% of the volume, humans set policy and break ties.
- **Upvotes among agents is a confidence cascade.** Reddit works because humans curate quality. Agents upvoting agents collapses fast unless every signal is grounded in external truth (replies, fork-clicks, revenue). Reactions must be *outcome-grounded*, not vibes.

## The thesis

**Agent-collaborative workspace for GTM.** Feed/thread structure is the primary interface. Humans and agents both post. Embeddings are the subscription primitive. MCP is the action layer. Every claim is grounded in a fact with provenance. Every mutation is an event. Every read returns a projection, not a row.

Category move = **interface-as-wedge**, not algorithm-as-wedge. Defensible because incumbents would have to throw away their core UX (forms + tables + dashboards) to copy it.

## Open questions

1. **TAM at the sharp end.** Buyer is "ops teams running >1K autonomous touches/month with multiple agents." Maybe 2K companies today, growing fast. Bet on the curve, not the snapshot.
2. **Multi-tenant vs single-tenant embeddings.** Shared embedding space → network effect on signal quality + privacy nightmare. Per-tenant → cold start every customer. Hard call, probably determines GTM shape.
3. **Where Sim plugs in.** If MCP is the action layer, every `act()` call is potentially a Sim workflow. Partnership angle, but also a bet on Sim winning orchestration.
4. **Whether the form factor transfers.** Moltbook went viral on novelty + crypto pump + Meta acquihire. Form working for B2B engagement is unproven.

## Validation plan (ordered)

1. **Dog-food on Jake's job hunt (week 1).** Every AI/data eng role = account, every hiring manager = contact, every job post + their LinkedIn = signal. N=1, real loop, unambiguous outcomes (interview / offer / ghosted). Tightest validation loop available; doesn't require selling anything.
2. **Public-data testbed (week 2-3).** GitHub Events, HN, Product Hunt, YC directory, SEC EDGAR, Reddit. ~10K entities, 500K signals in a weekend. Stress the embedding layer, subscription primitive, projection model.
3. **One design partner (week 4+).** Friendly PLG company → ingest HubSpot + Gmail + Gong, free for 3 months. Validate the *interface and schema*, not the algorithms (volume too low for that).
4. **Synthetic-to-real hybrid for conversation side** until partner #1.

### Things to flag now

- LinkedIn scraping is ToS-violating. Fine for case study, not for product. Plan for Apollo / People Data Labs / Clay APIs or consent flows.
- Any design partner = real PII handling. Encryption-at-rest, scoped tokens, deletion paths from day one. Breaking trust is fatal.
- Don't try to prove bandit convergence on one design partner. Volume too low. Use partner to validate *interface and schema*.
