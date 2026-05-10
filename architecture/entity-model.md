# Entity Model (v0)

Status: Draft, from session 001. Pre-implementation. Expect changes once we ship the dog-food loop.

## Design constraint

Optimized for agent access. Humans involved only at: (a) calls (recorded anyway), (b) querying the data, (c) approval gates. Otherwise the system is in a format AI consumes and acts on most efficiently.

## 10 core entities

### 1. Entity
Accounts, contacts, products. Has multiple embeddings (one per perspective: stack, pain, seniority, vertical, etc.) — not one giant vector. Different agents query different perspectives.

### 2. Fact
Atomic claim. `{subject, predicate, object, source, confidence, observed_at, supersedes}`.
Example: `{Keith_Rabkin, evaluating, agent_infra, post_42, 0.65, 2026-05-01, null}`.
Facts are append-only — supersession via the `supersedes` pointer, not mutation.

### 3. Event
Append-only log entry. Every mutation is an event. Current state is a projection. Free audit + replay. Schema: `{actor, action, target, payload, timestamp, prompt_hash}`.

### 4. Conversation
Calls, emails, threads. Speaker-tagged transcript + extracted claims + decisions + action items. The audio file is artifact; the structured projection is the agent surface. Stored: structured fields in DB (jsonb), audio in S3 with pointer.

### 5. Signal
Typed observation. `{entity, type, magnitude, embedding, source_event}`. Unified shape across post-scrape, call-claim, email-reply, GitHub-fork. Agents don't care that one came from LinkedIn and one from Gong — same shape.

### 6. Subscription
Predicate. `{owner, semantic_filter, structured_filter, threshold, action_on_match}`.
Agents AND humans subscribe. Owner can be an agent ID or user ID.

### 7. Touch
Outbound action. `{entity, channel, content, arm_assignments, sent_at, outcomes[]}`.

### 8. Outcome
Observed result. `{touch, type, value, observed_at}`. Grounds the feedback loop. Without outcomes, posteriors don't update and the system flies blind.

### 9. Gate
Human-approval checkpoint. `{policy, condition, requested_at, decided_by, decision}`. The *only* place humans must be in the loop.

### 10. Projection
Derived view. Computed per `(asker, query)`. Same Keith looks different to a scoring agent, an outreach agent, and a human. Cached but invalidated by relevant events.

## 5 interaction primitives

```
query(natural_language) → projection      # humans and agents both
subscribe(predicate) → feed                # push, not pull
act(tool, args) → event                    # every mutation is an MCP tool call
gate(action, policy) → decision            # human-in-loop boundary
cite(claim_id) → fact                      # every assertion is grounded
```

No SQL exposed. No ORM. No forms. The five primitives ARE the API surface for both agents and humans.

## Load-bearing principles

### Provenance on every claim
No claim exists without a source. Every fact links to source event → actor → prompt hash → input. Cite-or-die: every agent assertion includes a fact ID or it doesn't ship. This is the difference between an agent system that compounds and one that hallucinates itself into a corner.

### Subscriptions over dashboards
Dashboards are pull. Agents and humans both work better on push. The "Moltbook feed" is just `subscribe()` rendered. Default home screen for any actor (agent or human) is their subscription tail.

### Conversations as projections, not blobs
A call isn't a 60-min file someone might re-listen to. It's transcript + speakers + extracted facts + decisions + action items, all separately addressable. Agents read the facts; humans scrub the audio when something looks off.

### Cost-aware retrieval
Embedding lookup ($0.0001) and LLM lookup ($0.05) are different products. Data layer exposes both — cheap by default, escalate on demand. Invisible in incumbents and matters at scale.

### Event-sourced, not state-sourced
DB is the append-only event log. State is computed on-demand. Replay any past state ("what did agent X believe at 3pm Tuesday?"). Critical for debugging, attribution, bandits.

### Content-addressed facts
Each fact has a content hash. Edits create new versions. Pin agents to specific knowledge snapshots — "agent_v3 was running against knowledge_hash 0xabc, that's why it decided Y." Like Git for facts.

## Open / unresolved

### Reactions in the feed
Need to think more. Argued previously that agents upvoting agents is a confidence cascade. Right primitive is probably *outcome-grounded reactions* — "this signal led to a fork-click" / "this was wrong because X" — tied to ground truth, not vibes. Spec'd but not designed.

### Multi-tenant embeddings
Shared embedding space → network effect on signal quality + privacy nightmare. Per-tenant → cold start. Hard call, probably determines GTM shape. Open.

### Where Sim plugs in
If MCP is the action layer, every `act()` call is potentially a Sim workflow. Partnership angle but also a bet on Sim winning orchestration. Open.

### Memory hierarchy
L1 active context (in-prompt) → L2 working memory (Redis) → L3 semantic recall (vector store) → L4 cold archive (S3). Agents move data between layers by access pattern. Spec'd but not designed.
