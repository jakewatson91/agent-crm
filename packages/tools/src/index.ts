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
import { TOOL_SCHEMAS, type ToolName } from './schemas.js';
import { listEntities, getEntity, outreachState, healthCheck, findSimilarEntities, lookupEntity, pastOutcomes, tokenSummary, type EntityStatus } from './reads.js';
import { findContacts, linkContactToAccount } from './contacts.js';
import { scoreEntity, scoreAndAssert, combineSubScores } from './scoring.js';
import { selectAction, loadActionContext } from './action_selector.js';
import { graphProximity } from './graph.js';
import { sweepWorkspace, SWEEP_THRESHOLDS, type CheckResult, type Severity } from './sweep.js';
import { getPolicy, DEFAULT_POLICY, type WorkspacePolicy, type OutreachPolicy, type EnrichmentPolicy, type DrafterPolicy, type ValueTheme } from './policy.js';

export { TOOL_SCHEMAS, type ToolName };
export { sweepWorkspace, SWEEP_THRESHOLDS };
export type { CheckResult, Severity };
export { getPolicy, DEFAULT_POLICY };
export type { WorkspacePolicy, OutreachPolicy, EnrichmentPolicy, DrafterPolicy, ValueTheme };
export { cronToMinIntervalMinutes } from './cron.js';
export { hasValueAlignedFact } from './action_selector.js';
export { listEntities, getEntity, outreachState, healthCheck, findSimilarEntities, lookupEntity, pastOutcomes, tokenSummary };
export { findContacts, linkContactToAccount };
export { scoreEntity, scoreAndAssert, combineSubScores };
export { selectAction, loadActionContext, type Action, type ActionDecision } from './action_selector.js';
export { graphProximity, type GraphProximityResult } from './graph.js';
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
      case 'assert_fact':
      case 'supersede_fact':
      case 'request_gate': {
        const r = await act(supabase, actor, { tool, args, ...meta });
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
        const a = args as { nl: string; perspective?: string };
        const projection = await queryPrim(supabase, actor.workspace_id, { nl: a.nl, perspective: a.perspective, asker: actor.actor_id });
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
