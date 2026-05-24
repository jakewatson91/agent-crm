# Backlog

Forward-looking work. Items move OUT of this file when they enter a plan file or get shipped. New ideas go IN at the top of the relevant section. Keep it terse — full context lives in `project_state.md` once work starts.

## North star for next phase: more agent autonomy + mobile push

Jake's vision: the system runs itself end-to-end and pings him on his phone when there's a decision to make. He approves / rejects / postpones from the phone. No daily desktop check-in required.

Concrete shape:
- Agent acts on reversible things autonomously (already the model for source curator). Notifies after.
- Agent surfaces irreversible asks (send draft, dial contact, $ commitment) as phone-actionable notifications.
- For calls: "good time to call <name> at <company> — dial now, snooze 1h, or skip?" The agent has a reason: a recent signal, an inbound reply, a calendar gap.
- Approval / reject path is a single tap. No app to install if avoidable — iMessage / SMS / push via a service.
- All decisions still land in the existing events / gates / facts model — the phone surface is just a thinner client over the same approval queue.

## High-priority next session

0. **Finish account rescore backfill (carry-over, 2026-05-23).** Run `pnpm tsx scripts/rescore_all.ts` from repo root. Scores fact-bearing `account` entities in the demo workspace (af602fa1). State at hand-off: **27 of 283 accounts scored**. The free-tier OpenRouter quota (model `openai/gpt-oss-120b:free`, see `[[project_scorer_model_openrouter]]`) was exhausted today — daily resets 00:00 UTC, and each run caps at ~25 scores before 429s, so this needs ~10 daily runs to clear. Idempotent: already-scored accounts skip via the staleness guard, and the script is throttled (3.5s/call; `THROTTLE_MS=0` if on a paid model). Drop this item once coverage is full. Context: the scorer was silently broken all day (dead model + a skip-write bug, both fixed); contacts no longer get ICP scores (gate via `policy.scorable_types`); 1,663 empty seed accounts were archived (1,965 → 302 active).

1. **Phone-actionable notifications.** Use **Telegram bot** as the delivery channel (OpenClaw pattern). Why over Twilio SMS / Pushover: free, proactive messaging works without user-initiates (WhatsApp Business API can't do that), inline keyboard buttons map 1:1 to gate decisions, works on phone + desktop, no per-customer env var. Setup flow (self-serve): user runs `/newbot` with `@BotFather`, pastes token into workspace settings (`policy.notifications.telegram.bot_token`), DMs their bot once so we capture `chat_id` from the first update. Wire: gate write → `sendMessage` with `inline_keyboard` carrying `callback_data: "gate:<id>:approve|reject|snooze:<dur>"` → new `/api/telegram/webhook` → existing `/api/gates/decide`. Files: `apps/web/app/api/_lib/notify_telegram.ts` + `apps/web/app/api/telegram/webhook/route.ts` + settings UI.
2. **Call orchestrator.** New behavior (not a new agent — extend `claim_poster` or sit it inside `drafter`). Inputs: signal indicating a call moment (inbound reply mentioning meeting, "let's hop on", repeated engagement). Output: a `gate` of kind `dial_request` carrying `{contact_id, phone, reason, suggested_slot}`. Telegram notification offers `Dial / Snooze 1h / Skip` — Dial uses a `url:` button with `tel:+15551234567` (Telegram supports `url:` buttons alongside `callback_data:`).
3. **Reply ingest.** Already flagged in `Known issues (deferred)` in project_state. Resend inbound webhook → `inbound_email` fact. Once landed, the post-send loop closes (silenceSweep + cooldown already live) AND most call-trigger signals become available.
4. **Decide-and-notify expansion.** Source curator is the canonical example today. Map other reversible operations to the same pattern: rescore policy nudges, threshold tweaks, KB additions surfaced from the agent reading drafts. Each gets an `Undo` button via the existing `agent_action_taken` event + `/api/agent_actions/undo`.

## Smaller items (not blocking the above)

- **Onboarding rebuild (deferred).** Current wizard at `/workspace/new` works but isn't the focus right now. Eventual shape: one form — name + ICP description + "where do your starting accounts come from?" (free text → agent picks CSV / connector pull / search) + LLM key. Build after the enrichment simplification (seed + grounded scoring + cite chain + auto-cull) lands and we know what the new defaults should be.

- **Value-prop evidence bank.** Sketched in `/Users/jakewatson/.claude/plans/declarative-riding-bunny.md`. `policy.drafter.supporting_evidence[]` — third-party quotes the drafter can cite across outreach (e.g., the Anthropic substack on token cost). Build when first canonical quote has a clear home.
- **YC connector URL capture.** YC signals have no `yc_url` / `item_url` in `structured_tags` so the new hop-0 URL chip renders nothing for YC-sourced facts. Add the company's YC page URL to `structured_tags` at signal write time. One line in the connector, plus a backfill heuristic (`https://www.ycombinator.com/companies/<slug>`).
- **Reasoning text quality.** DeepSeek-v4 occasionally emits garbage CJK/Cyrillic mid-reasoning. Either a stricter sanitize pass, a length / non-ASCII ratio guard, or switch reasoning to a different model (gpt-4o-mini is the existing fallback). Display issue, not pipeline.
- **Reply-driven scoring boost.** Once reply ingest is live, an `inbound_email` fact with positive sentiment should bump `signal_strength` for the next rescore. Single weight rule in `scoring.ts`, but needs the data path first.
- **Embedding key per workspace.** Currently embeddings always hit env-OpenAI even when a customer has pasted their own key into `policy.llm.openai_api_key`. Thin wrapper around `embed()`. Wait for a customer to ask.

## Architecture / debt

- **Schema collapse: channels → entities.** Plan filed at repo root `TODO_entity_merge.md`. ~25 files + a migration to drop `channels` and re-point `channel_posts` to `entity_posts`. Defer to focused session.
- **Per-workspace secrets table with envelope encryption.** API keys currently live on `workspaces.policy` as a stopgap. Long-term: `workspace_secrets` table.
- **Connector marketplace / sharing across workspaces.** Today connectors are per-workspace rows in `sources`. No way to share a spec across customers.
- **Pain-extraction yield on real production signals.** Only validated on 4 synthetic fixtures. Run an audit on 7 days of real `signal_body_hash` runs once enough have accumulated and see what % produce pain facts vs noise.
- **Hallucination-rate harness for HubSpot vs agent-crm drafts.** One anecdote suggests HubSpot fabricates more. LLM-judge prompt + 100-draft sample on each side = a real number.

## Validation gaps

- End-to-end against a non-B2B vertical (real estate was the placeholder). Does the wizard-derived `example_facts` + drafter `pain_points` produce sensible drafts when the input description is something other than B2B SaaS?
