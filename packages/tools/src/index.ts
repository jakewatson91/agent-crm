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
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { TOOL_SCHEMAS, type ToolName } from './schemas.ts';
import { listEntities, getEntity, outreachState, healthCheck, findSimilarEntities, lookupEntity, pastOutcomes, tokenSummary, fetchSeenSignalTags, type EntityStatus } from './reads.ts';
import { findContacts, findContactsExplorium, linkContactToAccount, linkContactByProspectId, pullContactsForAccount, isRoleInboxEmail } from './contacts.ts';
import { scoreEntity, scoreAndAssert, combineSubScores, scoreContact } from './scoring.ts';
import { selectAction, loadActionContext } from './action_selector.ts';
import { graphProximity } from './graph.ts';
import { sweepWorkspace, SWEEP_THRESHOLDS, type CheckResult, type Severity } from './sweep.ts';
import { getPolicy, DEFAULT_POLICY, resolveEnvVar, invalidatePolicyCache, stampArgumentChanges, getPipelineStatus, type DrafterArgument, type WorkspacePolicy } from './policy.ts';
import { recordActivityMarker, ACTIVITY_MARKERS } from './activity_markers.ts';
import { ALIAS_MIN_CHARS } from './aliases.ts';
import { stampQuestionChanges } from './research_brief.ts';
import type { BriefQuestion } from './policy.ts';
import { readWorkspaceConfig, stageConfigChange, CONFIG_SECTIONS } from './workspace_config.ts';

export { TOOL_SCHEMAS, type ToolName };
export { sweepWorkspace, SWEEP_THRESHOLDS };
export type { CheckResult, Severity };
export { runExaSearch, fetchPageText, type ExaResult, type ExaSearchParams, type ExaSearchResult, type ExaContentsResult } from './exa_search.ts';
export { publishedDateFromUrl, resolvePublishedDate, parseContentDate, applyContentDate, unreadableContentDate, resolveHappenedAt, hiringEventDate, type ResolvedPublishedDate } from './published_date.ts';
export { generateResearchStrategy, planResearchAngles, ensureResearchStrategy, persistResearchStrategy, recordStrategyAttempt, stampRecordSince, carryOffSwitch, failedAngles, orphanedAngles, questionsWorthSearching, uncoveredQuestions, carryPinnedAngles, loadAngleRecords, clampQuery, angleRecordBlock, resolveStrategy, resolveContactStrategy, filterResultsByEntity, gateFailureReason, fetchEntityGrounding, pageMentionsEntity, readEntityAliases, dedupeResearchCandidates, DUP_LOOKBACK_DAYS, BASELINE_ANGLES, type PlannerContext, type AngleRecord, type RelevanceResult, type RelevanceTarget, type GateRejectReason } from './research_strategy.ts';
export { generateResearchBrief, planResearchBrief, ensureResearchBrief, persistResearchBrief, carryQuestionOffSwitch, stampQuestionChanges, briefInputHashFor, loadQuestionRecords, loadQuestionSearchRecords, unreachableQuestions, earnsItsSearches, makesAccountsWritable, questionsNotEarningTheirPages, questionsServingAPrecondition, BRIEF_REWRITE_COOLDOWN_HOURS, foldFetchedByQuestion, recordReading, resolveBrief, renderBrief, BASELINE_BRIEF, PAIN_QUESTION, FAIR_TRIAL_PAGES, MIN_ANSWER_RATE, MIN_DATED_RATE, MIN_FACTS_FOR_DATE_VERDICT, UNREACHABLE_PAGES, UNREACHABLE_TRIALS, UNREACHABLE_WINDOW_DAYS, type BriefContext, type QuestionRecord, type QuestionSearchRecord, type RunMarker } from './research_brief.ts';
export { resolveAliasesViaSearch, backfillAliases, validateAliases, usedAsProperNoun, ALIAS_MIN_CHARS, MAX_ALIASES, type AliasResolveOutcome, type AliasResolveStatus, type AliasRejection, type AliasRejectReason, type AliasValidation, type AliasBackfillResult } from './aliases.ts';
export { getSourceMetrics, type SourceMetric } from './source_metrics.ts';
export { resolveSourceForFacts, type FactSource } from './resolve_source.ts';
export { curateWorkspaceSources, type CuratorAction, type CuratorDecision, type CurateOpts } from './source_curator.ts';
export { runRetention, type RetentionResult, pruneHttpResponses, type HttpResponsePruneResult } from './retention.ts';
export { getPolicy, DEFAULT_POLICY, resolveEnvVar, invalidatePolicyCache };
export { DEFAULT_RESEARCH_SEARCHES_PER_RUN, DEFAULT_SELECTION_MIX, DEFAULT_TIER_CADENCE_HOURS, resolveTierCadenceHours, DEFAULT_EMPTY_RUN_BACKOFF_MAX, EMPTY_RUN_BACKOFF_TRIGGER, emptyRunBackoff, DEFAULT_MAX_OUTPUT_TOKENS, resolveMaxOutputTokens, MODEL_BEHAVIORS, resolveBehaviorModel, TIER_ANGLE_COUNT, RESEARCH_DISPATCH_CRON, DEFAULT_QUALIFICATION, resolveQualification } from './policy.ts';
export { getPipelineStatus, setPipelineStatus, getPipelineActivity, PIPELINE_ACTIVITY_ACTIONS, ensureScoringConfigState } from './policy.ts';
export type { PipelineActivity } from './policy.ts';
export { sendOwnerAlert, resolveOwnerEmail, notifyPipelinePaused, type AlertResult } from './notify.ts';
export { UNPROVEN_ARGUMENT_DRAFT_LIMIT, stampArgumentChanges } from './policy.ts';
export { readWorkspaceConfig, stageConfigChange, CONFIG_SECTIONS, isConfigSection, type ConfigSection, type ConfigRead, type ConfigChange } from './workspace_config.ts';
export type { DrafterArgument } from './policy.ts';
export { loadArgumentRecords, worthProposing, whyQuestioned, renderOutcomeBlock, MIN_WRONG_REASON, MIN_EDITS, type ArgumentRecord, type ArgumentOutcome } from './argument_review.ts';
export { DRAFT_VERDICTS, DRAFT_VERDICT_LABEL, DRAFT_VERDICT_HELP, isDraftVerdict, type DraftVerdict } from './draft_verdict.ts';
export { ARGUMENTS_PROMPT, sanitizeArguments } from './derive_arguments.ts';
export type { WorkspacePolicy, OutreachPolicy, EnrichmentPolicy, DrafterPolicy, HiringFilterPolicy, ResearchPolicy, ResearchAngle, BriefQuestion, QualificationPolicy, PipelineStatus, ModelBehavior } from './policy.ts';
export { cronToMinIntervalMinutes } from './cron.ts';
export { compress, estimateTokens, type CompressOptions, type CompressResult, type UrlRef } from './compress.ts';
export { chatCompleteForWorkspace, chatCompleteStreamForWorkspace, resolveDeepseekKey, resolveChatModel, type ChatForWorkspaceArgs } from './chat_workspace.ts';
export { classifyRole, passesHiringFilter, ROLE_FAMILIES, ROLE_SENIORITIES, type RoleFamily, type RoleSeniority, type RoleClassification, type HiringFilter } from './classify_role.ts';
export { suggestColumnMapping, type SuggestedMapping, type SuggestedFact } from './suggest_mapping.ts';
export { buildDrafterDecision, renderAttributesProse, type DrafterDecisionOpts, type StepPurpose } from './prompt_builders.ts';
export { pickDraftAngle, type AngleChoice, type AngleDecision, type AngleSkipReason, type AngleTemplate, type PickDraftAngleArgs } from './pick_angle.ts';
export { pickAnchorCandidates, cannotWriteAbout, DEFAULT_ANCHOR_FRESH_DAYS, type AnchorCandidate, type AnchorPick } from './anchor.ts';
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
export {
  SCORE_DIMS, VETO_KEY, explainScore, explainScoreChange, breakdownFromFacts, coerceBreakdown,
  type ScoreContribution, type ScoreExplanation, type ScoreMove, type ScoreMoveLine, type ScoreMoveCause,
  type ScoreOpts,
} from './scoring.ts';
export { graphProximity, type GraphProximityResult } from './graph.ts';
export { resolveOrCreateEntity, normalizeEntityName, trigramSim, looksLikeEntityName, type ResolveResult } from './resolve.ts';
export { findMergeCandidatesForEntity, mergeAccounts, dismissMergeCandidate, type MergeCandidate, type MergeResult } from './merge.ts';
export { getEntityTypes, getEntityTypesBatch, isEntityOfType, entityIdsOfType } from './entity_types.ts';
export { ingestRows, getPath, normalizeDomain, hashItem, type IngestSpec, type IngestProvenance, type IngestResult } from './ingest.ts';
export { setOutreachStage, DEFAULT_STAGE_FACT_NAME } from './lifecycle.ts';
export type { LifecyclePolicy, OutreachTransition } from './policy.ts';
export { factFamilyOf, type FactGroup, type DisplayPolicy } from './fact_groups.ts';
export { ACTIVITY_MARKERS, recordActivityMarker, latestMarkerAt, latestMarkerByEntity, countTrailingEmptyResearch, type ActivityMarker } from './activity_markers.ts';
export { fetchAll, chunk } from './paginate.ts';
export { resolvePeriod, collectPeriod, renderMarkdown, mdToHtml, DEFAULT_PRICING, isPeakHour, type PeriodWindow, type PeriodData, type EntityMove, type Pricing } from './report.ts';
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
 * Fact name for a note a person wrote. Structural, not vertical — every
 * workspace has people who know things — so it lives in code like the other
 * shapes, not in policy.
 *
 * Deliberately NOT in ADMIN_PREDICATES: a note is evidence about the account,
 * so it should raise evidence_depth and be readable by the drafter exactly like
 * a fact research found. That is the whole point of writing it here.
 */
export const NOTE_PREDICATE = 'note_from_team';

/** Signal type for a note, so the enricher can pull structured facts out of it. */
export const NOTE_SIGNAL_TYPE = 'human_note';

/**
 * Capabilities this package cannot reach on its own, supplied by the caller.
 *
 * `research_account` has to put a `research.requested` event on the bus, and the
 * bus lives in @agent-crm/inngest — which imports THIS package. Importing it
 * back, even dynamically, is a cycle, and a dynamic cross-package import inside
 * `packages/*` is the exact shape that let a broken bundle ship and fail every
 * Render deploy for six days (see CLAUDE.md). So the direction stays one-way and
 * the caller passes the function in instead.
 *
 * Everything is optional. A caller that supplies nothing keeps working exactly
 * as before; the tools that need a capability say plainly that it is not wired
 * here rather than failing in some other way.
 */
/**
 * Turn a drafter skip code into the thing that would fix it.
 *
 * These codes are computed on every nightly run and then discarded, so "why did
 * this account get nothing" has never had an answer outside the channel log.
 * The on-demand path is where a person is actually waiting for one.
 */
function draftBlockerHint(reason: string, name: string): string {
  switch (reason) {
    case 'no_writable_anchor':
      return `Every fresh thing known about ${name} is a subject this workspace never writes about. Research it again, or add what you know with add_note and a date.`;
    case 'precondition_unmet':
      return `Nothing on record shows the argument's "only if" is true of ${name}. Add the fact with add_note if you know it, or pick a different argument.`;
    case 'no_evidence':
      return `The argument fits, but no fact shows its event happened at ${name}. Research it, or add the event with add_note and a date.`;
    case 'no_problem_fits':
      return `None of this workspace's arguments reach ${name} on what is known so far.`;
    case 'all_facts_out_of_scope':
      return `Everything known about ${name} is about a part of their business this workspace cannot serve.`;
    case 'facts_insufficient_for_draft':
      return `Not enough known about ${name} to write anything true. Research it first.`;
    case 'forced_argument_missing':
      return 'That argument is not configured or not enabled on this workspace.';
    case 'argument_unproven':
      return 'That argument has written its trial messages and is waiting on a human to say they made sense.';
    case 'no_suitable_recipient':
    case 'no_matching_contact_role':
      return `No contact at ${name} to write to. Pull contacts for them first.`;
    default:
      return '';
  }
}

export interface ToolDeps {
  /**
   * Put an entity on the research queue. Resolves once the event is accepted.
   *
   * `tier` and `kind` are the unions the research.requested event actually
   * declares, not `string` — the loose version typechecked inside this package
   * and only failed at the web app, which is the stricter of the two projects
   * that compile this file (see CLAUDE.md on why the per-package typecheck is
   * never sufficient on its own).
   */
  requestResearch?: (event: {
    workspace_id: string;
    entity_id: string;
    entity_name: string;
    reason: string;
    tier?: 'hot' | 'default' | 'cold' | 'contact';
    angle_count?: number;
    kind?: 'account' | 'contact';
  }) => Promise<unknown>;
  /**
   * Run the drafter over one account now. Resolves with what happened, because
   * unlike research this is one call and the caller is waiting on the answer.
   *
   * Injected rather than imported: the drafter lives in the inngest project and
   * this package is upstream of it.
   */
  requestDraft?: (event: {
    workspace_id: string;
    entity_id: string;
    reason: string;
    force_argument_id?: string;
  }) => Promise<{ ok: boolean; action?: string; reason?: string; channel_post_id?: string; gate_id?: string }>;
}

/**
 * Single dispatch entrypoint for the tools. Each call:
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
  deps?: ToolDeps,
): Promise<ToolReturn> {
  const schema = TOOL_SCHEMAS[tool];
  const parse = schema.safeParse(rawArgs);
  if (!parse.success) return { ok: false, error: `Invalid args for ${tool}: ${parse.error.message}` };
  const args = parse.data as Record<string, unknown>;

  try {
    switch (tool) {
      case 'add_note': {
        const a = args as { entity_id: string; note: string; happened_at?: string; source?: string };
        // Scope check before any write. Without it a caller holding one
        // workspace's key could file a note against another workspace's entity
        // by id, and the fact would read as native to that account.
        const noteEnt = await supabase.from('entities')
          .select('id').eq('id', a.entity_id).eq('workspace_id', actor.workspace_id).maybeSingle();
        if (!noteEnt.data) return { ok: false, error: `entity ${a.entity_id} not found in this workspace` };
        const text = a.source ? `${a.note.trim()} (${a.source.trim()})` : a.note.trim();

        // Two writes, both through existing tools so the note gets the same
        // audit row, content-hash idempotency and cite chain as anything else.
        //
        // 1. The note verbatim, as a fact. This is the guarantee: a person typed
        //    something, and it is readable by the drafter the moment the call
        //    returns, whatever else does or does not happen afterwards.
        const factRes = await callTool(supabase, actor, 'assert_fact', {
          subject_entity: a.entity_id,
          predicate: NOTE_PREDICATE,
          object_text: text,
          // A person stating what they know first-hand is the most reliable
          // input the system takes. Same full value as an imported CRM field.
          confidence: 1.0,
          ...(a.happened_at ? { happened_at: a.happened_at } : {}),
        }, meta);
        if (!factRes.ok) return factRes;

        // 2. The same text as a signal, so the enricher reads it and pulls
        //    atomic facts out against the workspace's research questions, and
        //    the score picks up the new evidence. The enricher is told not to
        //    restate anything already in the account's active facts, so it
        //    extracts the structure and leaves the verbatim note alone.
        //
        //    A failure here is not fatal. The note is already recorded above;
        //    losing the extra extraction is worth far less than losing what the
        //    person wrote, so the tool still reports success.
        let signal_id: string | undefined;
        let enrichment_error: string | undefined;
        const sigRes = await callTool(supabase, actor, 'create_signal', {
          entity_id: a.entity_id,
          type: NOTE_SIGNAL_TYPE,
          // Notes are hand-written and rare, so they are worth more than a
          // scraped page by default and clear any subscription threshold.
          magnitude: 0.9,
          body_for_embedding: text,
          structured_tags: {
            kind: NOTE_SIGNAL_TYPE,
            author_kind: actor.actor_kind,
            author_id: actor.actor_id,
            ...(a.source ? { source: a.source } : {}),
            ...(a.happened_at ? { happened_at: a.happened_at } : {}),
          },
        }, meta);
        if (sigRes.ok) signal_id = sigRes.target_id;
        else enrichment_error = sigRes.error;

        return {
          ok: true,
          event_id: factRes.event_id,
          target_id: factRes.target_id,
          data: {
            fact_id: factRes.target_id,
            signal_id: signal_id ?? null,
            // True when this note can be the reason a message gets written.
            // Undated notes are still evidence, they just cannot open one.
            can_anchor_outreach: Boolean(a.happened_at),
            ...(enrichment_error ? { enrichment_error } : {}),
          },
        };
      }

      case 'list_approvals': {
        const a = args as { limit: number; policy?: string };
        let q = supabase
          .from('gates')
          .select('id, policy, condition, requested_by_agent, requested_at, channel_post_id')
          .eq('workspace_id', actor.workspace_id)
          .is('decided_at', null)
          .order('requested_at', { ascending: true })
          .limit(a.limit);
        if (a.policy) q = q.eq('policy', a.policy);
        const { data, error } = await q;
        if (error) return { ok: false, error: error.message };

        // How many are ACTUALLY waiting, which is not the same as how many rows
        // came back. `limit` pages the list; an agent asking "what needs me
        // today" against a queue of 28 must not be told 5 because it asked for
        // five rows. Counted separately, head-only, so it costs no payload.
        let countQ = supabase
          .from('gates')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', actor.workspace_id)
          .is('decided_at', null);
        if (a.policy) countQ = countQ.eq('policy', a.policy);
        const { count: pendingTotal } = await countQ;

        const rows = (data ?? []) as Array<{
          id: string; policy: string; condition: Record<string, unknown> | null;
          requested_by_agent: string; requested_at: string; channel_post_id: string | null;
        }>;
        const now = Date.now();
        // A token-efficient projection, not a row dump: enough for an agent to
        // decide, without pasting a whole email body per pending item.
        const pending = rows.map((g) => {
          const c = (g.condition ?? {}) as Record<string, unknown>;
          const body = typeof c.body === 'string' ? c.body : '';
          return {
            gate_id: g.id,
            policy: g.policy,
            requested_by: g.requested_by_agent,
            waiting_days: Math.floor((now - Date.parse(g.requested_at)) / 86400000),
            entity_id: (c.entity_id as string | undefined) ?? null,
            account: (c.entity_name as string | undefined) ?? null,
            channel: (c.channel_type as string | undefined) ?? null,
            to: (c.to_email as string | undefined) ?? null,
            subject: (c.subject as string | undefined) ?? null,
            preview: body ? `${body.slice(0, 180)}${body.length > 180 ? '…' : ''}` : null,
            channel_post_id: g.channel_post_id,
          };
        });
        return {
          ok: true, event_id: '', target_id: actor.workspace_id,
          data: {
            /** Everything waiting, whether or not it fitted in this page. */
            pending: pendingTotal ?? pending.length,
            /** How many are in `approvals` below. Raise `limit` to see more. */
            returned: pending.length,
            // The oldest thing waiting, because that is the one going stale.
            oldest_waiting_days: pending.length ? pending[0]!.waiting_days : 0,
            approvals: pending,
          },
        };
      }

      case 'draft_account': {
        const a = args as { entity_id: string; argument_id?: string; reason?: string };
        if (!deps?.requestDraft) {
          return { ok: false, error: 'draft_account is not available here: this deployment did not wire a drafter into callTool (see ToolDeps).' };
        }
        const ent = await supabase.from('entities')
          .select('id, name').eq('id', a.entity_id)
          .eq('workspace_id', actor.workspace_id).maybeSingle();
        if (!ent.data) return { ok: false, error: `entity ${a.entity_id} not found in this workspace` };
        const name = ent.data.name as string;

        // Naming an argument that is not configured is a typo, not a request to
        // let the picker choose. Answer it here, with the list, rather than
        // spending a model call to arrive at the same place.
        const policy = await getPolicy(supabase, actor.workspace_id);
        const configured = (policy.drafter?.arguments ?? []).filter((x) => x?.id && x.enabled !== false);
        if (a.argument_id && !configured.some((x) => x.id === a.argument_id)) {
          return {
            ok: false,
            error: `no enabled argument called "${a.argument_id}". This workspace has: ${configured.map((x) => x.id).join(', ') || '(none)'}`,
          };
        }

        const status = await getPipelineStatus(supabase, actor.workspace_id);
        if (status?.state === 'paused' && (status.scope ?? 'all') === 'all') {
          return { ok: false, error: `drafting is paused: ${status.reason ?? 'pipeline paused'}` };
        }

        const reason = a.reason?.trim() || `requested by ${actor.actor_kind}:${actor.actor_id}`;
        const r = await deps.requestDraft({
          workspace_id: actor.workspace_id,
          entity_id: a.entity_id,
          reason,
          ...(a.argument_id ? { force_argument_id: a.argument_id } : {}),
        });

        // A refusal is the useful half of this tool. The nightly pass computes
        // exactly these reasons and then swallows them, which is why "why did
        // nothing get written for this account" was only answerable by reading
        // the channel. Say it, and say what would fix it.
        if (!r.ok || r.action !== 'post_touch_draft') {
          const why = r.reason ?? r.action ?? 'unknown';
          return { ok: false, error: `${name}: ${why}. ${draftBlockerHint(why, name)}` };
        }
        return {
          ok: true, event_id: '', target_id: a.entity_id,
          data: { drafted: true, account: name, channel_post_id: r.channel_post_id, gate_id: r.gate_id,
                  note: 'The draft is waiting for approval. Nothing is sent until a human approves it.' },
        };
      }
      case 'research_account': {
        const a = args as { entity_id: string; angle_count?: number; reason?: string };
        if (!deps?.requestResearch) {
          return { ok: false, error: 'research_account is not available here: this deployment did not wire a research dispatcher into callTool (see ToolDeps).' };
        }
        const ent = await supabase.from('entities')
          .select('id, name, attributes').eq('id', a.entity_id)
          .eq('workspace_id', actor.workspace_id).maybeSingle();
        if (!ent.data) return { ok: false, error: `entity ${a.entity_id} not found in this workspace` };

        // No domain means no own-site search and no contact pull afterwards, so
        // a search here is spend with no possible payoff. The dispatcher applies
        // the same rule; saying so is more useful than queueing a dead run.
        const domain = (ent.data.attributes as { domain?: string } | null)?.domain;
        if (!domain) {
          return { ok: false, error: `${ent.data.name} has no resolved domain, so research would have nothing to search. The daily domain backfill resolves these on its own schedule.` };
        }

        // Don't queue work against a provider we already know is dead.
        const status = await getPipelineStatus(supabase, actor.workspace_id);
        if (status?.state === 'paused' && (status.scope ?? 'all') !== 'contacts') {
          return { ok: false, error: `research is paused: ${status.reason ?? 'pipeline paused'}` };
        }

        const reason = a.reason?.trim() || `requested by ${actor.actor_kind}:${actor.actor_id}`;
        // The health sweep reads this marker to know research was attempted;
        // written before dispatch so a run that fails still shows it was asked for.
        await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.RESEARCH_TRIGGERED, a.entity_id, { reason, on_demand: true });
        await deps.requestResearch({
          workspace_id: actor.workspace_id,
          entity_id: a.entity_id,
          entity_name: ent.data.name as string,
          reason,
          // On-demand means someone is waiting on it, so it gets the deepest
          // tier's angle budget unless the caller asked for fewer.
          tier: 'hot',
          ...(a.angle_count ? { angle_count: a.angle_count } : {}),
          kind: 'account',
        });
        return {
          ok: true, event_id: '', target_id: a.entity_id,
          data: {
            queued: true,
            account: ent.data.name,
            // Say plainly that nothing is readable yet, so a caller does not
            // immediately re-read the entity, find nothing new and conclude the
            // call failed.
            note: 'Searches run in the background. New facts land in a few minutes; read the entity again then.',
          },
        };
      }

      case 'pull_contacts': {
        const a = args as { entity_id: string };
        const r = await pullContactsForAccount(supabase, {
          workspace_id: actor.workspace_id,
          entity_id: a.entity_id,
        });
        // A pull that legitimately finds nobody is not a tool failure — the
        // account simply has no reachable decision-maker at this provider, and
        // the caller needs the reason, not an exception. Only report ok:false
        // when the pull could not run at all.
        return {
          ok: true, event_id: '', target_id: a.entity_id,
          data: { found: r.found, created: r.created, ran: r.ok, ...(r.reason ? { reason: r.reason } : {}) },
        };
      }

      case 'read_workspace_config': {
        const a = args as { section?: string };
        const data = await readWorkspaceConfig(supabase, actor.workspace_id, a.section);
        return { ok: true, event_id: '', target_id: actor.workspace_id, data };
      }

      case 'update_workspace_config': {
        const a = args as { section: string; value: unknown; reasoning: string };
        const staged = await stageConfigChange(supabase, actor.workspace_id, a.section, a.value);
        if ('error' in staged) return { ok: false, error: staged.error };
        // Through set_workspace_policy rather than writing the row here, so the
        // rules that sit under a policy write still run: rewriting an argument
        // drops its confirmation, rewording a question restarts its record.
        // Writing the row directly would be the one path that skips both.
        const r = await callTool(supabase, actor, 'set_workspace_policy', { policy: staged.next_policy });
        if (!r.ok) return r;
        return {
          ok: true,
          event_id: r.event_id,
          target_id: actor.workspace_id,
          data: { section: staged.section, before: staged.before, after: staged.after, reasoning: a.reasoning },
        };
      }

      case 'set_workspace_policy': {
        // Every write to policy.drafter.arguments comes through here — the
        // settings page, the narrow arguments route, a script, and any agent
        // tool built later. So the confirmation rule is applied here rather
        // than at a call site, where the next new caller would silently miss
        // it. Changing an argument's wording drops its confirmation and starts
        // its three-message trial over; leaving it alone keeps both.
        //
        // The settings page also clears proven_at in the browser. That stays,
        // because it makes the badge change under the customer's cursor rather
        // than after a round trip. It is no longer what enforces anything.
        const incomingArgs = (args.policy as { drafter?: { arguments?: unknown } } | undefined)?.drafter?.arguments;
        const incomingBrief = (args.policy as { research?: { brief?: unknown } } | undefined)?.research?.brief;
        if (Array.isArray(incomingArgs) || Array.isArray(incomingBrief)) {
          const current = await getPolicy(supabase, actor.workspace_id).catch(() => ({} as WorkspacePolicy));
          const policy = args.policy as {
            drafter?: { arguments?: DrafterArgument[] };
            research?: { brief?: BriefQuestion[] };
          };
          if (Array.isArray(incomingArgs)) {
            policy.drafter!.arguments = stampArgumentChanges(
              incomingArgs as DrafterArgument[],
              current.drafter?.arguments ?? [],
            );
          }
          // Same rule, same reason. A reworded question keeps its id so the facts
          // filed under it survive, which means the RECORD has to be told where
          // the new wording starts or the new question is judged on the numbers
          // of the one it replaced — and the record is what decides whether a
          // question gets rewritten again or dropped. persistResearchBrief
          // already does this on the planner's path; without it here, editing a
          // question through a tool would be the one way in that skips it.
          if (Array.isArray(incomingBrief)) {
            policy.research!.brief = stampQuestionChanges(
              incomingBrief as BriefQuestion[],
              current.research?.brief ?? [],
            );
          }
        }
        const r = await act(supabase, actor, { tool, args, ...meta });
        // record_event materializes the write into workspaces.policy
        // server-side, so the cached copy has to be dropped by hand.
        invalidatePolicyCache(r.target_id);
        return { ok: true, event_id: r.event_id, target_id: r.target_id };
      }

      case 'create_workspace':
      case 'create_account':
      case 'create_contact':
      case 'create_entity':
      case 'request_gate': {
        const r = await act(supabase, actor, { tool, args, ...meta });
        // record_event materializes these two tools' writes into
        // workspaces.policy server-side (no TS call site to hook otherwise),
        // and r.target_id is the workspace_id for both per act.ts's
        // TOOL_TARGET_KIND map.
        if (tool === 'create_workspace') invalidatePolicyCache(r.target_id);
        return { ok: true, event_id: r.event_id, target_id: r.target_id };
      }

      case 'assert_fact': {
        // record_event RPC ignores unknown payload fields, so we strip signal_id
        // out of the args we pass to act(). Then we set facts.signal_id directly
        // in a second statement. The `.is('signal_id', null)` clause makes this
        // a no-op on content-hash-deduped rows that already carry a signal
        // binding from their original assertion — preserves the cite-chain
        // truth that a fact's source is the FIRST signal that produced it.
        //
        // happened_at rides the same path for the same reason, and takes the
        // same `.is(null)` guard: a claim re-asserted from a second page keeps
        // the date it first carried, because the event happened once whatever
        // number of articles later mention it.
        const { signal_id, happened_at, ...actArgs } = args as { signal_id?: string; happened_at?: string } & Record<string, unknown>;
        const r = await act(supabase, actor, { tool, args: actArgs, ...meta });
        if (signal_id) {
          await supabase.from('facts').update({ signal_id }).eq('id', r.target_id).is('signal_id', null);
        }
        if (happened_at) {
          await supabase.from('facts').update({ happened_at }).eq('id', r.target_id).is('happened_at', null);
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
        //
        // happened_at inherits the same way. A supersede is a correction to what
        // a fact SAYS — a revised number, a fixed name — not a claim that the
        // underlying event happened again. Dropping the date on every correction
        // would quietly retire an anchor each time the enricher tidied a fact.
        const { signal_id, happened_at, supersedes } = args as { signal_id?: string; happened_at?: string; supersedes: string };
        const { signal_id: _sid, happened_at: _hat, ...actArgs } = args as { signal_id?: string; happened_at?: string } & Record<string, unknown>;
        const r = await act(supabase, actor, { tool, args: actArgs, ...meta });
        let bindSignalId: string | null = signal_id ?? null;
        let bindHappenedAt: string | null = happened_at ?? null;
        if (!bindSignalId || !bindHappenedAt) {
          const prior = await supabase.from('facts').select('signal_id, happened_at').eq('id', supersedes).maybeSingle();
          bindSignalId = bindSignalId ?? (prior.data?.signal_id as string | null) ?? null;
          bindHappenedAt = bindHappenedAt ?? (prior.data?.happened_at as string | null) ?? null;
        }
        if (bindSignalId) {
          await supabase.from('facts').update({ signal_id: bindSignalId }).eq('id', r.target_id);
        }
        if (bindHappenedAt) {
          await supabase.from('facts').update({ happened_at: bindHappenedAt }).eq('id', r.target_id);
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
    read_workspace_config: 'Read what this workspace is configured to do: the arguments it makes, the questions research goes looking for, the searches behind them, the scoring bars, and which model runs each job. Omit `section` to get all of it. The research questions in particular exist nowhere else a person can see, so this is the only way to answer "what is the agent actually looking for".',
    list_approvals: 'What is waiting on a human right now: every approval nobody has decided yet, oldest first, with the account, the channel, a preview of the message and how many days it has been sitting. Use this to answer "what needs me today" and to find the gate_id to pass to decide_gate. Sending is the one irreversible step, so this queue is the only place the pipeline stops for a person.',
    research_account: 'Go and research one account now instead of waiting for its turn in the schedule. Queues the workspace\'s search angles against it; the searches run in the background and land as new facts a few minutes later, so read the entity again after that rather than immediately. Costs search credit. Refuses, with the reason, when the account has no resolved domain (nothing to search) or when research is paused on a dead provider. Use it when you are working one company and need current facts before writing to them.',
    pull_contacts: 'Find decision-makers at an account through the workspace\'s configured contact provider and link them as contacts. Runs now and costs provider credit, within the workspace\'s monthly cap. Returns how many were found and how many were new. Finding nobody is a normal outcome and is reported as found:0, not an error — the account may have no reachable person at this provider. The daily pass already does this on its own schedule; call this when working one account on demand.',
    draft_account: 'Write an outbound draft for one account right now, instead of waiting for the nightly pass. Pass `argument_id` to choose which argument it makes; omit it to let the picker choose as it normally would. Choosing an argument does not force it through: the account still has to have a fact showing the event happened and, where the argument states a precondition, a fact showing that holds, otherwise this refuses and says which one is missing. The draft always opens an approval; nothing is sent by this call.',
    add_note: 'Record something a person knows about an account that no search would find: what someone said on a call, at an event, in a meeting. Writes it as a fact the drafter reads, and hands it to the enricher to pull structured facts out of. Pass `happened_at` (ISO date) when the note describes something that HAPPENED on a day — that is what lets the note become the reason a message gets written. Leave it off for standing background, which still raises the account\'s score and informs the argument but cannot open a message on its own.',
    update_workspace_config: 'Change one part of that config. Pass the finished value, not an instruction. Returns what it was and what it now is, and the change undoes from its event row. Rewriting an argument drops its confirmation so it writes three messages and waits to be read; rewording a research question restarts its track record. Call read_workspace_config first — the value replaces the section outright, so an edit to one item in a list must send the whole list.',
  };

  return (Object.keys(TOOL_SCHEMAS) as ToolName[]).map((name) => ({
    name,
    description: DESC[name],
    inputSchema: toInputSchema(TOOL_SCHEMAS[name]),
  }));
}

/**
 * The real Zod -> JSON Schema conversion, so an MCP client is told what each
 * tool actually takes.
 *
 * What was here before returned `{type:'object', additionalProperties:true}` for
 * every tool, on the theory that "MCP handles this via its own helpers in the
 * route handler". Nothing does. So the catalog advertised 29 tools with no
 * arguments at all, and a client had to guess every field name from the prose
 * description while `callTool` rejected each wrong guess with a Zod error. That
 * is the difference between an agent connecting to this CRM and an agent being
 * able to use it.
 *
 * `$refStrategy: 'none'` matters. The default hoists shared sub-schemas into
 * `$defs` and points at them with `$ref`, and our schemas share UuidSchema
 * across nearly every tool. Several MCP clients do not resolve `$ref` inside a
 * tool's inputSchema, so the shared fields would arrive as empty objects — the
 * same failure in a subtler form. Inlining costs a few bytes per tool and is
 * read once per session.
 */
function toInputSchema(schema: ZodTypeAny): object {
  const json = zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' }) as Record<string, unknown>;
  // zod-to-json-schema emits a top-level $schema key. Harmless, but it is not
  // part of the tool's argument shape, so drop it rather than ship it to every
  // client on every tool.
  delete json.$schema;
  return json;
}
