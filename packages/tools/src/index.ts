import type { SupabaseClient } from '@supabase/supabase-js';
import {
  act,
  cite as citePrim,
  embed,
  gate as gatePrim,
  decideGate,
  query as queryPrim,
  subscribe as subscribePrim,
  vectorLiteral,
  type Actor,
} from '@agent-crm/primitives';
import { TOOL_SCHEMAS, type ToolName } from './schemas.ts';
import { listEntities, getEntity, outreachState, healthCheck, findSimilarEntities, lookupEntity, pastOutcomes, tokenSummary, type EntityStatus } from './reads.ts';
import { findContacts, linkContactToAccount } from './contacts.ts';
import { scoreEntity, scoreAndAssert, combineSubScores } from './scoring.ts';
import { selectAction, loadActionContext } from './action_selector.ts';
import { graphProximity } from './graph.ts';
import { sweepWorkspace, SWEEP_THRESHOLDS, type CheckResult, type Severity } from './sweep.ts';
import { getPolicy, DEFAULT_POLICY, resolveEnvVar, type WorkspacePolicy, type OutreachPolicy, type EnrichmentPolicy, type DrafterPolicy, type ValueTheme, type HiringFilterPolicy } from './policy.ts';

export { TOOL_SCHEMAS, type ToolName };
export { sweepWorkspace, SWEEP_THRESHOLDS };
export type { CheckResult, Severity };
export { getSourceMetrics, type SourceMetric } from './source_metrics.ts';
export { resolveSourceForFacts, type FactSource } from './resolve_source.ts';
export { curateWorkspaceSources, type CuratorAction, type CuratorDecision, type CurateOpts } from './source_curator.ts';
export { getPolicy, DEFAULT_POLICY, resolveEnvVar };
export type { WorkspacePolicy, OutreachPolicy, EnrichmentPolicy, DrafterPolicy, ValueTheme, HiringFilterPolicy };
export { cronToMinIntervalMinutes } from './cron.ts';
export { compress, estimateTokens, type CompressOptions, type CompressResult, type UrlRef } from './compress.ts';
export { hasValueAlignedFact } from './action_selector.ts';
export { chatCompleteForWorkspace, chatCompleteStreamForWorkspace, resolveDeepseekKey, resolveChatModel, type ChatForWorkspaceArgs } from './chat_workspace.ts';
export { classifyRole, passesHiringFilter, ROLE_FAMILIES, ROLE_SENIORITIES, type RoleFamily, type RoleSeniority, type RoleClassification, type HiringFilter } from './classify_role.ts';
export { buildDrafterDecision, type DrafterDecisionOpts } from './prompt_builders.ts';
export { scoreFacts, DEFAULT_CONFIG as SCORE_FACTS_DEFAULTS, type FactRow, type FactScore, type FactScoreComponents, type ScoreFactsConfig } from './score_facts.ts';
export { listEntities, getEntity, outreachState, healthCheck, findSimilarEntities, lookupEntity, pastOutcomes, tokenSummary };
export { findContacts, linkContactToAccount };
export { scoreEntity, scoreAndAssert, combineSubScores };
export { selectAction, loadActionContext, type Action, type ActionDecision, type ActionThresholds, DEFAULT_THRESHOLDS, buildThresholds } from './action_selector.ts';
export { type ScoreWeights, DEFAULT_WEIGHTS, buildScoreWeights } from './scoring.ts';
export { graphProximity, type GraphProximityResult } from './graph.ts';
export { getEntityTypes, getEntityTypesBatch, isEntityOfType, entityIdsOfType, listWorkspaceTypes } from './entity_types.ts';
export { ingestRows, getPath, normalizeDomain, hashItem, type IngestSpec, type IngestProvenance, type IngestResult } from './ingest.ts';
export type { EntityStatus };

export interface ToolResult {
  ok: true;
  event_id: string;
  target_id: string;
  data?: unknown;
}

export interface ToolError {
  ok: false;
  error: string;
}

export type ToolReturn = ToolResult | ToolError;

/**
 * Single dispatch entrypoint for the 13 v0 tools. Each call:
 *   1. Validates args against the per-tool Zod schema.
 *   2. Routes to the right primitive (most go through `act` → `record_event`).
 *   3. Returns a uniform { event_id, target_id } shape so MCP / agents can chain.
 */
export async function callTool(
  supabase: SupabaseClient,
  actor: Actor,
  tool: ToolName,
  rawArgs: unknown,
  meta?: { prompt_hash?: string; parent_event_id?: string },
): Promise<ToolReturn> {
  const schema = TOOL_SCHEMAS[tool];
  const parse = schema.safeParse(rawArgs);
  if (!parse.success) return { ok: false, error: `Invalid args for ${tool}: ${parse.error.message}` };
  const args = parse.data as Record<string, unknown>;

  try {
    switch (tool) {
      case 'create_workspace':
      case 'set_workspace_policy':
      case 'create_account':
      case 'create_contact':
      case 'create_entity':
      case 'request_gate': {
        const r = await act(supabase, actor, { tool, args, ...meta });
        return { ok: true, event_id: r.event_id, target_id: r.target_id };
      }

      case 'assert_fact': {
        // record_event RPC ignores unknown payload fields, so we strip signal_id
        // out of the args we pass to act(). Then we set facts.signal_id directly
        // in a second statement. The `.is('signal_id', null)` clause makes this
        // a no-op on content-hash-deduped rows that already carry a signal
        // binding from their original assertion — preserves the cite-chain
        // truth that a fact's source is the FIRST signal that produced it.
        const { signal_id, ...actArgs } = args as { signal_id?: string } & Record<string, unknown>;
        const r = await act(supabase, actor, { tool, args: actArgs, ...meta });
        if (signal_id) {
          await supabase.from('facts').update({ signal_id }).eq('id', r.target_id).is('signal_id', null);
        }
        return { ok: true, event_id: r.event_id, target_id: r.target_id };
      }

      case 'supersede_fact': {
        // Supersede creates a NEW fact row. Its signal_id comes from (in order):
        // the caller's signal_id if provided, else the prior fact's signal_id
        // (inheritance), else null. The new row always gets *some* binding
        // when one exists upstream.
        const { signal_id, supersedes } = args as { signal_id?: string; supersedes: string };
        const { signal_id: _sid, ...actArgs } = args as { signal_id?: string } & Record<string, unknown>;
        const r = await act(supabase, actor, { tool, args: actArgs, ...meta });
        let bindSignalId: string | null = signal_id ?? null;
        if (!bindSignalId) {
          const prior = await supabase.from('facts').select('signal_id').eq('id', supersedes).maybeSingle();
          bindSignalId = (prior.data?.signal_id as string | null) ?? null;
        }
        if (bindSignalId) {
          await supabase.from('facts').update({ signal_id: bindSignalId }).eq('id', r.target_id);
        }
        return { ok: true, event_id: r.event_id, target_id: r.target_id };
      }

      case 'update_source': {
        // Mutate the source row first, then record the event with prior_state
        // in the payload. The record_event RPC validates target_kind; we use
        // 'source' (added in migration 0022) so undo can query events directly
        // by target_kind+target_id.
        const a = args as {
          source_id: string;
          active?: boolean;
          config?: Record<string, unknown>;
          prior_state: Record<string, unknown>;
          reasoning: string;
        };
        const patch: Record<string, unknown> = {};
        if (typeof a.active === 'boolean') patch.active = a.active;
        if (a.config !== undefined) patch.config = a.config;
        if (Object.keys(patch).length === 0) {
          return { ok: false, error: 'update_source: nothing to update (active and config both undefined)' };
        }
        const upd = await supabase.from('sources').update(patch).eq('id', a.source_id).eq('workspace_id', actor.workspace_id);
        if (upd.error) return { ok: false, error: `sources update failed: ${upd.error.message}` };
        const r = await act(supabase, actor, {
          tool: 'update_source',
          target_id: a.source_id,
          args: { source_id: a.source_id, patch, prior_state: a.prior_state, reasoning: a.reasoning },
          ...meta,
        });
        return { ok: true, event_id: r.event_id, target_id: r.target_id };
      }

      case 'create_signal': {
        // Tool wrapper handles the embedding so callers don't have to.
        const a = args as { entity_id: string; type: string; magnitude: number; body_for_embedding: string; structured_tags: Record<string, unknown> };
        const vec = await embed(a.body_for_embedding);
        const r = await act(supabase, actor, {
          tool: 'create_signal',
          args: {
            entity_id: a.entity_id,
            type: a.type,
            magnitude: a.magnitude,
            body_for_embedding: a.body_for_embedding,
            embedding: vectorLiteral(vec),
            structured_tags: a.structured_tags,
          },
          ...meta,
        });
        return { ok: true, event_id: r.event_id, target_id: r.target_id };
      }

      case 'create_subscription': {
        // SubscribeArgs in primitives is { owner_kind, owner_id, name, filter: { semantic, structured, threshold, action } }.
        // Tool exposes flat shape; map here.
        const flat = args as {
          owner_kind: 'agent' | 'user';
          owner_id: string;
          name: string;
          semantic_query: string;
          structured_filter: Record<string, unknown>;
          threshold: number;
          action_on_match: string;
        };
        const r = await subscribePrim(supabase, actor, {
          owner_kind: flat.owner_kind,
          owner_id: flat.owner_id,
          name: flat.name,
          filter: {
            semantic: flat.semantic_query,
            structured: flat.structured_filter,
            threshold: flat.threshold,
            action: flat.action_on_match,
          },
        });
        return { ok: true, event_id: r.event_id, target_id: r.subscription_id };
      }

      case 'post_to_channel': {
        const r = await act(supabase, actor, { tool: 'post_to_channel', args, ...meta });
        return { ok: true, event_id: r.event_id, target_id: r.target_id };
      }

      case 'decide_gate': {
        const a = args as { gate_id: string; decision: 'approve' | 'reject' | 'modify' };
        const r = await decideGate(supabase, actor, a.gate_id, a.decision);
        return { ok: true, event_id: r.event_id, target_id: a.gate_id };
      }

      case 'query': {
        const a = args as { nl: string; perspective?: string; source_id?: string };
        const projection = await queryPrim(supabase, actor.workspace_id, { nl: a.nl, perspective: a.perspective, asker: actor.actor_id, source_id: a.source_id });
        // Pull-only primitive: no event row, but we return the projection as data.
        return { ok: true, event_id: '', target_id: '', data: projection };
      }

      case 'cite': {
        const a = args as { id: string };
        const result = await citePrim(supabase, { id: a.id });
        return { ok: true, event_id: '', target_id: a.id, data: result };
      }

      case 'list_entities': {
        const a = args as { status?: EntityStatus; signal_source?: string; limit: number; since_hours?: number };
        const data = await listEntities(supabase, actor.workspace_id, a);
        return { ok: true, event_id: '', target_id: '', data };
      }

      case 'get_entity': {
        const a = args as { entity_id: string };
        const data = await getEntity(supabase, actor.workspace_id, a.entity_id);
        return { ok: true, event_id: '', target_id: a.entity_id, data };
      }

      case 'outreach_state': {
        const a = args as { entity_id: string };
        const data = await outreachState(supabase, actor.workspace_id, a.entity_id);
        return { ok: true, event_id: '', target_id: a.entity_id, data };
      }

      case 'health_check': {
        const data = await healthCheck(supabase, actor.workspace_id);
        return { ok: true, event_id: '', target_id: '', data };
      }

      case 'find_similar_entities': {
        const a = args as { entity_id: string; top_k: number; perspective?: string };
        const data = await findSimilarEntities(supabase, actor.workspace_id, a);
        return { ok: true, event_id: '', target_id: a.entity_id, data };
      }

      case 'lookup_entity': {
        const a = args as { name: string; fuzzy: boolean; limit: number };
        const data = await lookupEntity(supabase, actor.workspace_id, a);
        return { ok: true, event_id: '', target_id: '', data };
      }

      case 'past_outcomes': {
        const a = args as { entity_id?: string; signal_type?: string; semantic_neighbors: boolean; limit: number; since_days: number };
        const data = await pastOutcomes(supabase, actor.workspace_id, a);
        return { ok: true, event_id: '', target_id: a.entity_id ?? '', data };
      }

      case 'find_contacts': {
        const a = args as { domain: string; limit: number; role_filter?: string };
        const data = await findContacts(a);
        return { ok: true, event_id: '', target_id: '', data };
      }

      case 'link_contact_to_account': {
        const a = args as { account_entity_id: string; name: string; email: string; role?: string };
        const data = await linkContactToAccount(supabase, actor, a);
        return { ok: true, event_id: '', target_id: data.contact_entity_id, data };
      }

      case 'score_entity': {
        const a = args as { entity_id: string; assert: boolean };
        const data = a.assert
          ? await scoreAndAssert(supabase, actor, a.entity_id)
          : await scoreEntity(supabase, actor.workspace_id, a.entity_id);
        return { ok: true, event_id: '', target_id: a.entity_id, data };
      }

      case 'token_summary': {
        const a = args as { since_hours: number };
        const data = await tokenSummary(supabase, actor.workspace_id, a);
        return { ok: true, event_id: '', target_id: '', data };
      }

      default: {
        const _exhaustive: never = tool;
        return { ok: false, error: `Unknown tool: ${String(_exhaustive)}` };
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * MCP tool descriptors for advertising the tool surface to MCP clients
 * (Claude Desktop, Claude Code, etc.). Schemas converted to JSON Schema.
 */
export function listToolDescriptors(): Array<{ name: string; description: string; inputSchema: object }> {
  // We hand-write descriptions because Zod doesn't carry them.
  const DESC: Record<ToolName, string> = {
    create_workspace: 'Create a new workspace with persona, ICP, and policy.',
    set_workspace_policy: 'Update a workspace persona, ICP, budget, or policy.',
    create_account: 'Create an account entity in the current workspace.',
    create_contact: 'Create a contact entity, optionally linked to an account.',
    create_entity: 'Create an entity of any kind (e.g. opportunity). The kind is recorded as the entity\'s is_a fact. No channel is created.',
    assert_fact: 'Assert an atomic claim about an entity. Idempotent on content hash.',
    supersede_fact: 'Replace a prior fact with a corrected one. Original is preserved.',
    create_signal: 'Record a typed observation about an entity. Embedding is computed automatically.',
    create_subscription: 'Save a long-running filter rule that fires when matching signals arrive.',
    post_to_channel: 'Post a message to an account channel. Used by agents to surface decisions and claims.',
    query: 'Ask a natural-language question over the workspace. Returns a projection with cites.',
    cite: 'Resolve a fact id to its full provenance chain (fact → source event → prompt hash).',
    request_gate: 'Open a human-approval gate. Triggers notifications per workspace policy.',
    decide_gate: 'Approve, reject, or modify a pending gate. Human-only in practice.',
    list_entities: 'List entities in the workspace with their outreach status, fact count, signal types, and latest activity. Token-efficient summaries, sorted by latest activity.',
    get_entity: 'Get the full projection for one entity: facts, recent signals, recent posts, channel id. Use this when you need ground truth before drafting or scoring.',
    outreach_state: 'Check the current outreach state for one entity: has a draft? gated? last activity? fact count? Use this to avoid duplicate work or to pick up where you left off.',
    health_check: 'Self-diagnostic for the agent runtime. Returns counts of unmatched signals, errored sources, stale gates, and stale drafts. Use to detect when the system is wedged.',
    find_similar_entities: 'Vector search across entity embeddings. Given a source entity_id, returns the top_k most similar entities by cosine similarity. Use to find prospects that look like an existing customer or pattern.',
    lookup_entity: 'Find entities by name. Supports fuzzy ILIKE matching against entities.name. Use when you have a company name from a signal or external source and need its entity_id to call other tools.',
    past_outcomes: 'Recent gate decisions (approved / rejected / modified) for the given entity, semantically similar entities, or signals of the same type. Use to learn what happened last time we drafted to companies like this.',
    find_contacts: 'Find contacts (name, email, role, seniority) at a domain via Hunter.io. Token-efficient projection. Quota: 25/mo free, 500/mo paid.',
    link_contact_to_account: 'Create a contact entity and link it to an account via works_at + email + role facts. Idempotent on email: if a contact with the same email already exists, returns its id.',
    score_entity: 'Score an entity for ICP fit using workspace.icp + workspace.about + entity facts. Returns icp_fit in [0,1] + breakdown + reasoning. With assert=true, also asserts icp_fit + icp_fit_breakdown facts (idempotent via supersede).',
    token_summary: 'Aggregate token usage across recent agent runs. Returns totals + per-model + per-behavior breakdown. Reads from agent_run_metrics events. Tokens only, no pricing.',
    update_source: 'Mutate a source row (active flag, config). Caller must pass prior_state so the resulting event row is undo-ready. Used by the source curator to deactivate dead sources and rewrite queries.',
  };

  return (Object.keys(TOOL_SCHEMAS) as ToolName[]).map((name) => ({
    name,
    description: DESC[name],
    inputSchema: zodToJsonSchemaShallow(TOOL_SCHEMAS[name]),
  }));
}

// Minimal Zod -> JSON Schema converter for v0. We don't need full coverage; the tool
// arg shapes are flat objects with primitives, records, enums, and arrays.
function zodToJsonSchemaShallow(schema: unknown): object {
  // The MCP SDK supports passing zod schemas directly via z.toJSONSchema in newer versions.
  // For v0 we let MCP handle this via its own helpers in the route handler.
  return { type: 'object', additionalProperties: true };
}
