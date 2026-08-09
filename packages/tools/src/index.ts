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
import { listEntities, getEntity, outreachState, healthCheck, findSimilarEntities, lookupEntity, pastOutcomes, tokenSummary, fetchSeenSignalTags, type EntityStatus } from './reads.ts';
import { findContacts, findContactsExplorium, linkContactToAccount, linkContactByProspectId, pullContactsForAccount, isRoleInboxEmail } from './contacts.ts';
import { scoreEntity, scoreAndAssert, combineSubScores, scoreContact } from './scoring.ts';
import { selectAction, loadActionContext } from './action_selector.ts';
import { graphProximity } from './graph.ts';
import { sweepWorkspace, SWEEP_THRESHOLDS, type CheckResult, type Severity } from './sweep.ts';
import { getPolicy, DEFAULT_POLICY, resolveEnvVar } from './policy.ts';
import { ALIAS_MIN_CHARS } from './aliases.ts';

export { TOOL_SCHEMAS, type ToolName };
export { sweepWorkspace, SWEEP_THRESHOLDS };
export type { CheckResult, Severity };
export { runExaSearch, fetchPageText, type ExaResult, type ExaSearchParams, type ExaSearchResult, type ExaContentsResult } from './exa_search.ts';
export { publishedDateFromUrl, resolvePublishedDate, parseContentDate, applyContentDate, unreadableContentDate, type ResolvedPublishedDate } from './published_date.ts';
export { generateResearchStrategy, planResearchAngles, ensureResearchStrategy, persistResearchStrategy, resolveStrategy, resolveContactStrategy, filterResultsByEntity, fetchEntityGrounding, pageMentionsEntity, readEntityAliases, dedupeResearchCandidates, DUP_LOOKBACK_DAYS, BASELINE_ANGLES, type PlannerContext, type RelevanceResult, type RelevanceTarget, type GateRejectReason } from './research_strategy.ts';
export { generateResearchBrief, planResearchBrief, ensureResearchBrief, persistResearchBrief, briefInputHashFor, resolveBrief, renderBrief, BASELINE_BRIEF, PAIN_QUESTION, type BriefContext, type QuestionRecord } from './research_brief.ts';
export { resolveAliasesViaSearch, backfillAliases, validateAliases, usedAsProperNoun, ALIAS_MIN_CHARS, MAX_ALIASES, type AliasResolveOutcome, type AliasResolveStatus, type AliasRejection, type AliasRejectReason, type AliasValidation, type AliasBackfillResult } from './aliases.ts';
export { getSourceMetrics, type SourceMetric } from './source_metrics.ts';
export { resolveSourceForFacts, type FactSource } from './resolve_source.ts';
export { curateWorkspaceSources, type CuratorAction, type CuratorDecision, type CurateOpts } from './source_curator.ts';
export { runRetention, type RetentionResult } from './retention.ts';
export { getPolicy, DEFAULT_POLICY, resolveEnvVar };
export { DEFAULT_RESEARCH_SEARCHES_PER_RUN, DEFAULT_SELECTION_MIX, TIER_ANGLE_COUNT, RESEARCH_DISPATCH_CRON, DEFAULT_QUALIFICATION, resolveQualification } from './policy.ts';
export { getPipelineStatus, setPipelineStatus, ensureScoringConfigState } from './policy.ts';
export { sendOwnerAlert, resolveOwnerEmail, notifyPipelinePaused, type AlertResult } from './notify.ts';
export type { WorkspacePolicy, OutreachPolicy, EnrichmentPolicy, DrafterPolicy, HiringFilterPolicy, ResearchPolicy, ResearchAngle, BriefQuestion, QualificationPolicy, PipelineStatus } from './policy.ts';
export { cronToMinIntervalMinutes } from './cron.ts';
export { compress, estimateTokens, type CompressOptions, type CompressResult, type UrlRef } from './compress.ts';
export { chatCompleteForWorkspace, chatCompleteStreamForWorkspace, resolveDeepseekKey, resolveChatModel, type ChatForWorkspaceArgs } from './chat_workspace.ts';
export { classifyRole, passesHiringFilter, ROLE_FAMILIES, ROLE_SENIORITIES, type RoleFamily, type RoleSeniority, type RoleClassification, type HiringFilter } from './classify_role.ts';
export { suggestColumnMapping, type SuggestedMapping, type SuggestedFact } from './suggest_mapping.ts';
export { buildDrafterDecision, renderAttributesProse, type DrafterDecisionOpts } from './prompt_builders.ts';
export { pickDraftAngle, type AngleChoice, type AngleDecision, type AngleSkipReason, type AngleTemplate, type PickDraftAngleArgs } from './pick_angle.ts';
export { diffDraftBody, type ParagraphDiff } from './diff_draft.ts';
export { scoreFacts, DEFAULT_CONFIG as SCORE_FACTS_DEFAULTS, type FactRow, type FactScore, type FactScoreComponents, type ScoreFactsConfig } from './score_facts.ts';
export { listEntities, getEntity, outreachState, healthCheck, findSimilarEntities, lookupEntity, pastOutcomes, tokenSummary, fetchSeenSignalTags };
export { currentFactRows } from './reads.ts';
export { findContacts, findContactsExplorium, linkContactToAccount, linkContactByProspectId, pullContactsForAccount, isRoleInboxEmail };
export type { PullContactsResult } from './contacts.ts';
export { scoreEntity, scoreAndAssert, combineSubScores, scoreContact };
export { buildContactWeights, DEFAULT_CONTACT_WEIGHTS, decisionPower, personaMatch } from './scoring.ts';
export { selectAction, loadActionContext, loadBestContactScore, type Action, type ActionDecision, type ActionThresholds, DEFAULT_THRESHOLDS, buildThresholds } from './action_selector.ts';
export { type ScoreWeights, DEFAULT_WEIGHTS, buildScoreWeights, isSubstantiveFact, ADMIN_PREDICATES, type ScoreBreakdown, ageDecay, contactContentFacts, DEFAULT_MAX_AGE_DAYS, DEFAULT_DECAY_HALF_LIFE_DAYS, DEFAULT_CONTACT_MAX_AGE_DAYS, HOOK_CLASS_WEIGHT, RESEARCH_SIGNAL_BASE_MAGNITUDE, researchSignalMagnitude } from './scoring.ts';
export { graphProximity, type GraphProximityResult } from './graph.ts';
export { resolveOrCreateEntity, normalizeEntityName, trigramSim, looksLikeEntityName, type ResolveResult } from './resolve.ts';
export { findMergeCandidatesForEntity, mergeAccounts, dismissMergeCandidate, type MergeCandidate, type MergeResult } from './merge.ts';
export { getEntityTypes, getEntityTypesBatch, isEntityOfType, entityIdsOfType } from './entity_types.ts';
export { ingestRows, getPath, normalizeDomain, hashItem, type IngestSpec, type IngestProvenance, type IngestResult } from './ingest.ts';
export { setOutreachStage, DEFAULT_STAGE_FACT_NAME } from './lifecycle.ts';
export type { LifecyclePolicy, OutreachTransition } from './policy.ts';
export { factFamilyOf, type FactGroup, type DisplayPolicy } from './fact_groups.ts';
export { ACTIVITY_MARKERS, recordActivityMarker, latestMarkerAt, latestMarkerByEntity, type ActivityMarker } from './activity_markers.ts';
export { fetchAll, chunk } from './paginate.ts';
export { resolvePeriod, collectPeriod, renderMarkdown, mdToHtml, DEFAULT_PRICING, type PeriodWindow, type PeriodData, type EntityMove, type Pricing } from './report.ts';
export { backfillAccountDomainsFromContactEmails, domainFromEmail, resolveDomainViaSearch, type DomainBackfillResult, type DomainResolveOutcome, type DomainResolveRejection } from './domains.ts';
export {
  CONNECTORS, CONNECTOR_CATEGORIES, getConnector, resolveConnectorState,
  type ConnectorDef, type ConnectorField, type ConnectorCategory,
  type ConnectorState, type ConnectorHealth, type ResolveStateInput,
} from './connectors.ts';
export type { EntityStatus };

export interface ToolResult {
  ok: true;
  event_id: string;
  target_id: string;
  data?: unknown;
  // assert_fact only: true when this call inserted a new fact row, false on a
  // content-hash dedup hit (the fact was already known). Lets callers avoid
  // counting re-asserts of known facts as "new."
  created?: boolean;
  // create_signal only: true when a matching dedup_key signal already existed,
  // so this call skipped the embed + insert and returned the existing row.
  // event_id is '' on a deduped hit (no new event was written).
  deduped?: boolean;
}

export interface ToolError {
  ok: false;
  error: string;
}

export type ToolReturn = ToolResult | ToolError;

// Window for create_signal's dedup_key idempotency lookup. Matches the ATS
// connector's default cross-run dedup window (720h / 30d) so a re-listed item
// is recognized as the same observation rather than a fresh one.
const SIGNAL_DEDUP_WINDOW_MS = 30 * 86400 * 1000;

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
        // record_event sets facts.source_event_id to the new event only on
        // INSERT; a content-hash dedup hit returns the pre-existing fact, whose
        // source_event_id is an earlier event. So source_event_id === this
        // event_id iff we just created the row. Race-safe (no count-delta) and
        // needs no change to the record_event return columns.
        const { data: factRow } = await supabase
          .from('facts').select('source_event_id').eq('id', r.target_id).maybeSingle();
        // facts.source_event_id is a bigint → comes back as a JS number, but act()
        // returns event_id stringified (String(row.event_id)). A raw === compared
        // number-vs-string and was ALWAYS false, so every assert_fact reported
        // created:false — the enricher then counted 0 facts even when it wrote them
        // (no rescore, spurious "no facts" events). Compare as strings.
        const sourceEventId = (factRow as { source_event_id?: number | string } | null)?.source_event_id;
        const created = sourceEventId != null && String(sourceEventId) === r.event_id;
        return { ok: true, event_id: r.event_id, target_id: r.target_id, created };
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

      case 'set_entity_aliases': {
        // Read-modify-write: attributes also carries domain (and merge bookkeeping),
        // so replacing the whole object would silently drop the domain the research
        // runner and every contact lookup depend on.
        const a = args as { entity_id: string; aliases: string[]; prior_state: Record<string, unknown>; reasoning: string };
        const ent = await supabase.from('entities').select('attributes')
          .eq('id', a.entity_id).eq('workspace_id', actor.workspace_id).maybeSingle();
        if (ent.error) return { ok: false, error: `entity read failed: ${ent.error.message}` };
        if (!ent.data) return { ok: false, error: `set_entity_aliases: entity ${a.entity_id} not found in this workspace` };
        const attributes = (ent.data.attributes ?? {}) as Record<string, unknown>;

        // The name gate discards any token under its 4-character floor, so an
        // alias below it is a fix that would never fire. Reject loudly instead
        // of storing something inert the caller believes is working.
        const cleaned: string[] = [];
        const tooShort: string[] = [];
        const seen = new Set<string>();
        for (const raw of a.aliases) {
          const alias = raw.trim();
          if (!alias) continue;
          const key = alias.toLowerCase().replace(/[^a-z0-9]+/g, '');
          if (key.length < ALIAS_MIN_CHARS) { tooShort.push(alias); continue; }
          if (seen.has(key)) continue;
          seen.add(key);
          cleaned.push(alias);
        }
        if (tooShort.length) {
          return { ok: false, error: `set_entity_aliases: ${tooShort.map((s) => `"${s}"`).join(', ')} under ${ALIAS_MIN_CHARS} characters — the name gate ignores tokens that short, so storing them would do nothing` };
        }

        // An empty list is a legitimate write: it removes aliases that turned
        // out to admit junk. Drop the key entirely rather than storing [], so a
        // cleared account is indistinguishable from one never given aliases.
        const { aliases: _prior, ...rest } = attributes;
        const nextAttributes: Record<string, unknown> = cleaned.length ? { ...rest, aliases: cleaned } : rest;
        const upd = await supabase.from('entities').update({ attributes: nextAttributes })
          .eq('id', a.entity_id).eq('workspace_id', actor.workspace_id);
        if (upd.error) return { ok: false, error: `entities update failed: ${upd.error.message}` };
        const r = await act(supabase, actor, {
          tool: 'set_entity_aliases',
          target_id: a.entity_id,
          args: { entity_id: a.entity_id, aliases: cleaned, prior_state: a.prior_state, reasoning: a.reasoning },
          ...meta,
        });
        return { ok: true, event_id: r.event_id, target_id: r.target_id, data: { aliases: cleaned } };
      }

      case 'create_signal': {
        // Tool wrapper handles the embedding so callers don't have to.
        const a = args as { entity_id: string; type: string; magnitude: number; body_for_embedding: string; structured_tags: Record<string, unknown>; dedup_key?: string };
        // Idempotency: when the caller passes a stable dedup_key (a connector's
        // external id for the item), skip the embed + insert entirely if a signal
        // with the same entity + type + key already exists in the recent window.
        // Stops a source that re-sees the same item (e.g. a job board re-listing
        // an open role) from writing duplicate rows or burning an embedding call.
        if (a.dedup_key) {
          const since = new Date(Date.now() - SIGNAL_DEDUP_WINDOW_MS).toISOString();
          const existing = await supabase.from('signals')
            .select('id')
            .eq('workspace_id', actor.workspace_id)
            .eq('entity_id', a.entity_id)
            .eq('type', a.type)
            .gte('observed_at', since)
            .contains('structured_tags', { dedup_key: a.dedup_key })
            .limit(1)
            .maybeSingle();
          if (existing.data?.id) {
            return { ok: true, event_id: '', target_id: existing.data.id as string, deduped: true };
          }
        }
        // Stamp dedup_key into structured_tags so the lookup above matches next run.
        const tags = a.dedup_key ? { ...a.structured_tags, dedup_key: a.dedup_key } : a.structured_tags;
        const vec = await embed(a.body_for_embedding);
        const r = await act(supabase, actor, {
          tool: 'create_signal',
          args: {
            entity_id: a.entity_id,
            type: a.type,
            magnitude: a.magnitude,
            body_for_embedding: a.body_for_embedding,
            embedding: vectorLiteral(vec),
            structured_tags: tags,
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
        const a = args as { gate_id: string; decision: 'approve' | 'reject' | 'modify'; resolution?: Record<string, unknown> };
        const r = await decideGate(supabase, actor, a.gate_id, a.decision, a.resolution);
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
        const policy = await getPolicy(supabase, actor.workspace_id);
        const data = await findContacts({ ...a, apiKey: resolveEnvVar(policy, 'HUNTER_API_KEY') });
        return { ok: true, event_id: '', target_id: '', data };
      }

      case 'link_contact_to_account': {
        const a = args as { account_entity_id: string; name: string; email: string; role?: string };
        const data = await linkContactToAccount(supabase, actor, a);
        return { ok: true, event_id: '', target_id: data.contact_entity_id ?? '', data };
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
    health_check: 'Self-diagnostic for the agent runtime. Returns counts of errored sources, stale approvals, and stale drafts. Use to detect when the system is wedged.',
    find_similar_entities: 'Vector search across entity embeddings. Given a source entity_id, returns the top_k most similar entities by cosine similarity. Use to find prospects that look like an existing customer or pattern.',
    lookup_entity: 'Find entities by name. Supports fuzzy ILIKE matching against entities.name. Use when you have a company name from a signal or external source and need its entity_id to call other tools.',
    past_outcomes: 'Recent gate decisions (approved / rejected / modified) for the given entity, semantically similar entities, or signals of the same type, including any human note and what was edited before send. Use to learn what happened — and why — last time we drafted to companies like this.',
    find_contacts: 'Find contacts (name, email, role, seniority) at a domain via Hunter.io. Token-efficient projection. Quota: 25/mo free, 500/mo paid.',
    link_contact_to_account: 'Create a contact entity and link it to an account via works_at + email + role facts. Idempotent on email: if a contact with the same email already exists, returns its id.',
    score_entity: 'Score an entity for ICP fit using workspace.icp + workspace.about + entity facts. Returns icp_fit in [0,1] + breakdown + reasoning. With assert=true, also asserts icp_fit + icp_fit_breakdown facts (idempotent via supersede).',
    token_summary: 'Aggregate token usage across recent agent runs. Returns totals + per-model + per-behavior breakdown. Reads from agent_run_metrics events. Tokens only, no pricing.',
    update_source: 'Mutate a source row (active flag, config). Caller must pass prior_state so the resulting event row is undo-ready. Used by the source curator to deactivate dead sources and rewrite queries.',
    set_entity_aliases: 'Set the other names an account is covered under, so research stops dropping articles that never use its registered name (Crazy Maple Studio is written about as "ReelShort"). Replaces the whole list, so pass every alias to keep and an empty list to clear one that was letting junk through. Each must be at least 4 characters. Pass prior_state so the event row is undo-ready.',
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
