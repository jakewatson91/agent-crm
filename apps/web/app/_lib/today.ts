/**
 * "Today": the full recap of what the system did in the last 24 hours.
 *
 * This is the workspace home and the one page a founder should be able to read
 * before a cofounder meeting: every pass that ran, every account that moved and
 * why, every article the agent read, every fact it learned, every contact it
 * found, every draft it wrote or refused to write, what each connected service
 * is doing, and what it all cost. Nothing here is a work queue: the agent has
 * already acted. It is a record of its work plus the short list of things only
 * a person can decide.
 *
 * Performance rules this file follows (the page has a <500ms warm budget):
 *   - every read is windowed and batched, no N+1, no per-account queries;
 *   - `.in()` lists are chunked at 150 and paged with fetchAll, because
 *     PostgREST silently caps a SELECT at 1000 rows and overflows long URLs;
 *   - the whole thing is cached 120s under the same tags as the feed, so a
 *     gate decision refreshes both;
 *   - the 14-day trend is a separate, longer-lived cache: it barely changes
 *     between page loads and would otherwise cost a multi-day read every 2 min.
 */
import { unstable_cache } from 'next/cache';
import { createServerClient } from '@agent-crm/db';
import {
  fetchAll,
  chunk,
  CONNECTORS,
  resolveConnectorState,
  cronToMinIntervalMinutes,
  isSubstantiveFact,
  DEFAULT_PRICING,
  type ResolveStateInput,
  type Pricing,
} from '@agent-crm/tools';

// ---------------------------------------------------------------- shapes

export interface TodayWindow {
  since: string;
  until: string;
  label: string;
  hours: number;
}

/** The headline numbers. Everything below is the detail behind one of these. */
export interface TodayCounters {
  researchRuns: number;
  searches: number;
  signals: number;
  accountsResearched: number;
  factsLearned: number;
  painsFound: number;
  accountsScored: number;
  scoreUp: number;
  scoreDown: number;
  contactPulls: number;
  contactsFound: number;
  draftsWritten: number;
  draftsDeclined: number;
  approvalsPending: number;
  approvalsDecided: number;
  domainsResolved: number;
  domainsFailed: number;
  signalsPassedOver: number;
  spendUsd: number;
  spendPerDayUsd: number;
}

/** One pass of one scheduled job: when it ran, what it did, what broke. */
export interface TodayRun {
  id: string;
  kind: 'research' | 'outreach' | 'domains' | 'maintenance';
  label: string;
  startedAt: string;
  endedAt: string;
  stats: Array<{ label: string; value: string }>;
  accounts: Array<{ id: string; name: string }>;
  accountsMore: number;
  errors: string[];
  ok: boolean;
  /** A capped sample of this pass's own output, so a stat like "18 facts learned"
   *  can be opened up instead of taken on faith. Same row shapes as the sections
   *  further down the page, so a run's drill-down looks like what it's a slice of. */
  learned: TodayLearned[];
  signals: TodaySignal[];
  contacts: TodayContact[];
  drafts: TodayDraft[];
  declines: TodayDecline[];
  domains: Array<{ entity_id: string; name: string; domain: string }>;
}

export interface TodayMove {
  entity_id: string;
  name: string;
  scorePrev: number | null; // null = first score in the window
  scoreNew: number;
  delta: number;
  /** The sub-score that moved most since before the window. */
  driver: { key: string; prev: number; next: number; fact_ids?: string[] } | null;
  reasoning: string | null;
  /** The enricher's own write-up of the best-evidenced new fact. */
  claim: { post_id: string; created_at: string; body: string; cites: string[] } | null;
  facts: Array<{ id: string; predicate: string; object: string }>;
  signals: number;
  hasDraft: boolean;
  hasContact: boolean;
}

export interface TodaySignal {
  id: string;
  entity_id: string | null;
  entity_name: string;
  angle: string;
  source: string;
  magnitude: number | null;
  url: string | null;
  publishedAt: string | null;
  createdAt: string;
  title: string;
  snippet: string;
  /** What the enricher did with it. */
  outcome: 'facts' | 'nothing_new' | 'duplicate' | 'unread';
  factCount: number;
}

export interface TodayLearned {
  entity_id: string;
  name: string;
  facts: Array<{ id: string; predicate: string; object: string; pain: boolean }>;
}

export interface TodayContact {
  entity_id: string;
  name: string;
  role: string | null;
  email: string | null;
  score: number | null;
  account_id: string | null;
  account_name: string | null;
}

export interface TodayDraft {
  post_id: string;
  entity_id: string;
  entity_name: string;
  body: string;
  cites: string[];
  cite_quotes: { fact_id: string; quote: string }[];
  reasoning: string | null;
  createdAt: string;
  pending: boolean;
}

export interface TodayDecline {
  entity_id: string;
  entity_name: string;
  tag: string | null;
  reason: string;
  at: string;
}

export interface TodayDecided {
  entity_name: string;
  decision: string;
  at: string;
  edited: boolean;
}

export interface TodayConnector {
  id: string;
  name: string;
  category: string;
  health: 'connected' | 'not_connected' | 'error';
  role: 'primary' | 'fallback' | null;
  missing: string[];
  fromServer: boolean;
  alert: string | null;
  /** What it actually did in the window: evidence it works, not just config. */
  usage: string | null;
}

export interface TodaySource {
  id: string;
  name: string;
  type: string;
  active: boolean;
  lastRunAt: string | null;
  status: string | null;
  summary: string;
  /** The connector's own error text from its last run, when it failed. */
  error: string | null;
  overdue: boolean;
  signals7d: number;
}

export interface TodayAlert {
  id: string;
  severity: 'red' | 'amber';
  title: string;
  detail: string;
  href: string | null;
  hrefLabel: string | null;
}

export interface TodaySpend {
  byModel: Array<{
    model: string;
    behaviors: string[];
    runs: number;
    input: number;
    cached: number;
    output: number;
    usd: number | null;
  }>;
  exa: { searches: number; usd: number };
  llmUsd: number;
  totalUsd: number;
  perDayUsd: number;
}

export interface TodayTrendPoint {
  day: string;
  signals: number;
  scored: number;
  drafts: number;
}

export interface TodayData {
  window: TodayWindow;
  generatedAt: string;
  pipeline: { paused: boolean; scope: string | null; reason: string | null; provider: string | null; pausedAt: string | null };
  counters: TodayCounters;
  alerts: TodayAlert[];
  runs: TodayRun[];
  movers: TodayMove[];
  moversMore: number;
  signals: TodaySignal[];
  signalsMore: number;
  signalAngles: Array<{ angle: string; count: number; withFacts: number }>;
  learned: TodayLearned[];
  learnedMore: number;
  contacts: TodayContact[];
  drafts: TodayDraft[];
  declines: TodayDecline[];
  decided: TodayDecided[];
  connectors: TodayConnector[];
  sources: TodaySource[];
  spend: TodaySpend;
}

// ---------------------------------------------------------------- constants

const WINDOW_HOURS = 24;
/** A scheduled pass finishes within minutes; a gap this long means a new pass. */
const RUN_GAP_MIN = 30;

const MOVERS_CAP = 12;
const SIGNALS_CAP = 30;
const LEARNED_CAP = 18;
const CONTACTS_CAP = 20;
const DECLINES_CAP = 12;

/** How much of a single pass's own output to sample on its run card. */
const RUN_LEARNED_ENTITIES_CAP = 4;
const RUN_SIGNALS_CAP = 6;
const RUN_CONTACTS_CAP = 6;
const RUN_DRAFTS_CAP = 4;
const RUN_DECLINES_CAP = 4;
const RUN_DOMAINS_CAP = 10;

/** Facts that identify a record rather than teach us something about it. */
const IDENTITY_PREDICATES = new Set(['is_a', 'email', 'role', 'works_at', 'outreach_stage', 'domain', 'signal_summary']);

const SUB_SCORE_KEYS = ['industry_match', 'stage_match', 'signal_strength', 'evidence_depth', 'recency', 'graph_proximity'] as const;

/** Event actions we need the full payload for. Everything else is counted by name. */
const DETAIL_ACTIONS = [
  'research_completed', 'research_error', 'contacts_completed', 'create_contact',
  'agent_run_metrics', 'domain_resolved', 'domain_resolve_failed',
  'action_selector_skip', 'health_alert', 'retention_run', 'agent_dispatch_result',
  'enrichment_skipped', 'enrichment_no_facts',
];

// ---------------------------------------------------------------- helpers

// The scorer sometimes prefixes a sentence with a machine field label
// ("industry_match:", "Industry:"). That's a single token + colon (shape, not
// any vertical-specific value), so strip it so the line reads as prose.
function stripFieldLabel(s: string): string {
  return s.replace(/^[A-Za-z]+(?:_[A-Za-z]+)*:\s+/, '');
}

/** One-to-two clean sentences, cut on a sentence boundary, never mid-word. */
function firstSentences(s: string, max: number): string {
  const t = stripFieldLabel(s.trim().replace(/\s+/g, ' '));
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  const lastStop = slice.lastIndexOf('. ');
  if (lastStop > 60) return slice.slice(0, lastStop + 1);
  return slice.trimEnd() + '…';
}

/**
 * A scraped page's text starts with its own title, usually repeated, then nav
 * junk ("Login", "MORE STORIES"), then the article. Pull a headline and the
 * first real sentence out of that so the signal reads like something a person
 * would skim, not like a raw dump.
 */
function pageHeadline(raw: string): { title: string; snippet: string } {
  const lines = raw.split('\n')
    .map((l) => l
      .replace(/^[#>\s]+/, '')            // heading hashes, blockquote arrows
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown links → their text
      .trim())
    .filter((l) => l && !/^https?:\/\/\S+$/.test(l));
  const title = lines[0] ?? '';
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = norm(title);
  const body = lines.find((l, i) => i > 0 && l.length > 70 && !norm(l).includes(t) && !t.includes(norm(l))) ?? '';
  return { title: title.slice(0, 130), snippet: firstSentences(body, 190) };
}

// The scorer writes its reasoning for itself, so it names its own rubric fields
// ("stage_match defaults to 0.4", "no COMPANY GROUND TRUTH"). The number is
// already shown above the sentence, and the field names mean nothing to a
// reader, so drop the bookkeeping clauses and say the rest in words. Display
// only: the stored reasoning is untouched.
const REASONING_WORDS: Array<[RegExp, string]> = [
  [/\bindustry_match\b/gi, 'industry match'],
  [/\bstage_match\b/gi, 'stage and size'],
  [/\bsignal_strength\b/gi, 'signal strength'],
  [/\bevidence_depth\b/gi, 'evidence depth'],
  [/\bgraph_proximity\b/gi, 'network proximity'],
  [/\brrf_prefilter\b/gi, 'shortlist rank'],
  [/\bICP'?s?\b/g, 'your ideal customer'],
];
const BOOKKEEPING = /ground truth|defaults? to \d|no (company|data) (ground truth|provided)|so .{0,20}defaults?/i;

function cleanReasoning(s: string): string {
  let t = s.replace(/\s+/g, ' ').trim();
  for (const [re, word] of REASONING_WORDS) t = t.replace(re, word);
  const sentences = t.split(/(?<=\.)\s+/).filter(Boolean);
  const kept = sentences.filter((x) => !BOOKKEEPING.test(x));
  return (kept.length ? kept : sentences.slice(0, 1)).join(' ');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/**
 * Provider failures arrive as "angle: Provider 402 {…json…}; angle2: …", which
 * is unreadable on a page. Pull out the provider's own sentence, drop the JSON,
 * and say how many searches it hit.
 */
function plainError(raw: string): string {
  const detail = /"error"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1]?.replace(/\\"/g, '"');
  const stripped = raw.replace(/\{[^{}]*\}/g, '').trim();
  const parts = stripped.split(';').map((s) => s.trim()).filter(Boolean);
  const heads = [...new Set(parts.map((s) => s.split(':').slice(1).join(':').trim() || s))];
  const head = heads[0] ?? firstSentences(raw, 80);
  if (!detail) return firstSentences(raw, 220);
  const scope = parts.length > 1 ? ` (${parts.length} searches affected)` : '';
  return `${head}: ${detail}${scope}`;
}

/** Split time-ordered rows wherever the gap between them exceeds `gapMin`. */
function clusterByGap<T>(rows: T[], at: (r: T) => string, gapMin = RUN_GAP_MIN): T[][] {
  const sorted = [...rows].sort((a, b) => at(a).localeCompare(at(b)));
  const out: T[][] = [];
  let cur: T[] = [];
  let last = 0;
  for (const r of sorted) {
    const t = Date.parse(at(r));
    if (cur.length && t - last > gapMin * 60_000) {
      out.push(cur);
      cur = [];
    }
    cur.push(r);
    last = t;
  }
  if (cur.length) out.push(cur);
  return out;
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Read a dot path out of a nested object (e.g. 'outreach.from_email'). */
function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

// ---------------------------------------------------------------- row types

interface EventRow { action: string; created_at: string; target_id: string | null; payload: Record<string, any> | null }
interface EventLite { action: string; created_at: string }
interface SignalRow { id: string; entity_id: string | null; type: string; magnitude: number | null; structured_tags: Record<string, any> | null; created_at: string }
interface FactRow { id: string; predicate: string; subject_entity: string; object_text: string | null; object_entity: string | null; observed_at: string }
interface PostRow {
  id: string; kind: string; body: string | null; cites: string[] | null;
  cite_quotes: { fact_id: string; quote: string }[] | null; created_at: string;
  author_id: string; parent_post_id: string | null; channels: { account_entity_id: string } | null;
}
interface GateRow {
  id: string; policy: string; decision: string | null; requested_at: string; decided_at: string | null;
  condition: Record<string, any> | null; resolution: Record<string, any> | null; channel_post_id: string | null;
}
interface SourceRow {
  id: string; name: string; connector_type: string; active: boolean; schedule_cron: string | null;
  last_run_at: string | null; last_run_status: string | null; last_run_summary: Record<string, any> | null;
}

// ---------------------------------------------------------------- row → card shape
// Shared by the full-day sections and by each run card's own drill-down, so a
// fact or a signal renders identically wherever it shows up on the page.

function groupFactsByEntity(fs: FactRow[], N: (id: string | null | undefined) => string): TodayLearned[] {
  const byEntity = new Map<string, TodayLearned['facts']>();
  for (const f of fs) {
    const list = byEntity.get(f.subject_entity) ?? [];
    list.push({
      id: f.id,
      predicate: f.predicate,
      object: (f.object_text ?? '').replace(/\s+/g, ' ').slice(0, 240),
      pain: f.predicate === 'pain_observed',
    });
    byEntity.set(f.subject_entity, list);
  }
  return [...byEntity].map(([id, facts]) => ({ entity_id: id, name: N(id), facts: facts.slice(0, 6) }));
}

function toTodaySignal(
  s: SignalRow,
  bodyOf: Map<string, string>,
  factsBySignal: Map<string, number>,
  noFactSignals: Set<string>,
  skippedSignals: Set<string>,
  N: (id: string | null | undefined) => string,
): TodaySignal {
  const tags = s.structured_tags ?? {};
  const { title, snippet } = pageHeadline(bodyOf.get(s.id) ?? '');
  const factCount = factsBySignal.get(s.id) ?? 0;
  const outcome: TodaySignal['outcome'] =
    factCount > 0 ? 'facts'
      : noFactSignals.has(s.id) ? 'nothing_new'
        : skippedSignals.has(s.id) ? 'duplicate'
          : 'unread';
  return {
    id: s.id,
    entity_id: s.entity_id,
    entity_name: N(s.entity_id),
    angle: String(tags.research_angle ?? tags.signal_source ?? s.type ?? 'signal'),
    source: String(tags.signal_source ?? s.type ?? 'signal'),
    magnitude: s.magnitude,
    url: (tags.url as string) ?? null,
    publishedAt: (tags.published_at as string) ?? null,
    createdAt: s.created_at,
    title,
    snippet,
    outcome,
    factCount,
  };
}

function toTodayContact(
  id: string,
  roleOf: Map<string, string>,
  emailOf: Map<string, string>,
  worksAtOf: Map<string, string>,
  contactScoreOf: Map<string, number>,
  N: (id: string | null | undefined) => string,
): TodayContact {
  const accountId = worksAtOf.get(id) ?? null;
  return {
    entity_id: id,
    name: N(id),
    role: roleOf.get(id) ?? null,
    email: emailOf.get(id) ?? null,
    score: contactScoreOf.get(id) ?? null,
    account_id: accountId,
    account_name: accountId ? N(accountId) : null,
  };
}

function toTodayDraft(
  p: PostRow,
  reasoningByParent: Map<string, string>,
  pendingPostIds: Set<string>,
  N: (id: string | null | undefined) => string,
): TodayDraft {
  return {
    post_id: p.id,
    entity_id: p.channels?.account_entity_id ?? '',
    entity_name: N(p.channels?.account_entity_id),
    body: (p.body ?? '').trim(),
    cites: p.cites ?? [],
    cite_quotes: p.cite_quotes ?? [],
    reasoning: reasoningByParent.get(p.id) ?? null,
    createdAt: p.created_at,
    pending: pendingPostIds.has(p.id),
  };
}

function toTodayDecline(
  d: { entity_id: string; tag: string | null; reason: string; at: string },
  N: (id: string | null | undefined) => string,
): TodayDecline {
  return { entity_id: d.entity_id, entity_name: N(d.entity_id), tag: d.tag, reason: d.reason, at: d.at };
}

// ---------------------------------------------------------------- main read

const _getTodayData = async (ws: string): Promise<TodayData> => {
  const sb = createServerClient();
  const until = new Date().toISOString();
  const since = new Date(Date.now() - WINDOW_HOURS * 3600e3).toISOString();
  const window: TodayWindow = { since, until, label: `last ${WINDOW_HOURS} hours`, hours: WINDOW_HOURS };

  // ---- Round 1: everything that needs no ids from another query.
  const [wsRow, detailEvents, allEvents, signals, facts, posts, pendingGates, decidedGates, sourceRows] = await Promise.all([
    sb.from('workspaces').select('policy').eq('id', ws).maybeSingle(),
    fetchAll<EventRow>((f, t) => sb.from('events')
      .select('action, created_at, target_id, payload')
      .eq('workspace_id', ws).in('action', DETAIL_ACTIONS)
      .gte('created_at', since).lt('created_at', until).range(f, t)),
    // Names + timestamps only: enough to count every action without pulling
    // hundreds of fat payloads (a supersede_fact payload carries a full score
    // breakdown; there are ~400 of them a day).
    fetchAll<EventLite>((f, t) => sb.from('events')
      .select('action, created_at')
      .eq('workspace_id', ws).gte('created_at', since).lt('created_at', until).range(f, t)),
    fetchAll<SignalRow>((f, t) => sb.from('signals')
      .select('id, entity_id, type, magnitude, structured_tags, created_at')
      .eq('workspace_id', ws).gte('created_at', since).lt('created_at', until)
      .order('created_at', { ascending: false }).range(f, t)),
    fetchAll<FactRow>((f, t) => sb.from('facts')
      .select('id, predicate, subject_entity, object_text, object_entity, observed_at')
      .eq('workspace_id', ws).gte('observed_at', since).lt('observed_at', until)
      .order('observed_at', { ascending: true }).range(f, t)),
    fetchAll<PostRow>((f, t) => sb.from('channel_posts')
      .select('id, kind, body, cites, cite_quotes, created_at, author_id, parent_post_id, channels!inner(workspace_id, account_entity_id)')
      .eq('channels.workspace_id', ws)
      .gte('created_at', since).lt('created_at', until)
      .order('created_at', { ascending: true }).range(f, t) as unknown as PromiseLike<{ data: PostRow[] | null; error: { message: string } | null }>),
    sb.from('gates').select('id, policy, decision, requested_at, decided_at, condition, resolution, channel_post_id')
      .eq('workspace_id', ws).is('decision', null).order('requested_at', { ascending: true }),
    sb.from('gates').select('id, policy, decision, requested_at, decided_at, condition, resolution, channel_post_id')
      .eq('workspace_id', ws).gte('decided_at', since).lt('decided_at', until).order('decided_at', { ascending: false }),
    sb.from('sources').select('id, name, connector_type, active, schedule_cron, last_run_at, last_run_status, last_run_summary').eq('workspace_id', ws),
  ]);

  const policy = (wsRow.data?.policy ?? {}) as Record<string, any>;
  const pl = (policy.pipeline ?? {}) as Record<string, any>;
  const pipeline = {
    paused: pl.state === 'paused',
    scope: (pl.scope as string) ?? null,
    reason: (pl.reason as string) ?? null,
    provider: (pl.provider as string) ?? null,
    pausedAt: (pl.paused_at as string) ?? null,
  };

  const ev = (action: string) => detailEvents.filter((e) => e.action === action);
  const countOf = (action: string) => allEvents.reduce((n, e) => (e.action === action ? n + 1 : n), 0);

  // ---- Scores: latest in the window per account (facts are ordered ascending).
  const newScoreOf = new Map<string, number>();
  for (const f of facts) {
    if (f.predicate !== 'icp_fit') continue;
    const v = num(f.object_text);
    if (v !== null) newScoreOf.set(f.subject_entity, v);
  }
  const scoredIds = [...newScoreOf.keys()];

  // ---- Facts the agent actually learned (research output, not bookkeeping).
  const learnedFacts = facts.filter((f) => isSubstantiveFact(f.predicate) && !IDENTITY_PREDICATES.has(f.predicate));

  // ---- Signals, and what the enricher did with each.
  const factsBySignal = new Map<string, number>();
  for (const e of ev('agent_dispatch_result')) {
    const sid = e.payload?.signal_id;
    if (sid) factsBySignal.set(sid, (factsBySignal.get(sid) ?? 0) + (e.payload?.facts_asserted ?? 0));
  }
  const noFactSignals = new Set(ev('enrichment_no_facts').map((e) => e.payload?.signal_id).filter(Boolean));
  const skippedSignals = new Set(ev('enrichment_skipped').map((e) => e.payload?.signal_id).filter(Boolean));

  // ---- Enricher claims: the one best-evidenced write-up per account.
  // The enricher re-extracts the same underlying fact across passes and writes a
  // fresh claim each time with different wording. Those aren't two facts, they're
  // one fact said twice, and no cheap string check separates that from two real
  // claims: so only ever surface the best-evidenced one (most citations, longest
  // as the tiebreak) rather than trying to de-dup near-identical prose.
  const claimsOf = new Map<string, { post_id: string; created_at: string; body: string; cites: string[] }>();
  for (const p of posts) {
    if (p.kind !== 'claim') continue;
    const entId = p.channels?.account_entity_id;
    const cites = p.cites ?? [];
    if (!entId || cites.length === 0) continue;
    const body = (p.body ?? '').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const best = claimsOf.get(entId);
    if (best && (best.cites.length > cites.length || (best.cites.length === cites.length && best.body.length >= body.length))) continue;
    claimsOf.set(entId, { post_id: p.id, created_at: p.created_at, body: firstSentences(body, 220), cites });
  }

  // ---- Drafts, declines, approvals.
  const draftPosts = posts.filter((p) => p.kind === 'touch_draft');
  const pendingPostIds = new Set(
    ((pendingGates.data ?? []) as GateRow[]).map((g) => g.channel_post_id).filter(Boolean) as string[],
  );
  // A `decision` child post is the plain-language reasoning for its parent
  // draft (same parent-collapse convention as feed_items.ts / WhyThis elsewhere).
  const reasoningByParent = new Map<string, string>();
  for (const p of posts) {
    if (p.parent_post_id && p.kind === 'decision') reasoningByParent.set(p.parent_post_id, p.body ?? '');
  }

  // A refusal to draft shows up two ways: the action selector skipping an
  // account outright, and the drafter reaching the model and choosing not to
  // write ("[facts_insufficient_for_draft] …"). Both are decisions worth
  // reading: they say what the agent is still missing.
  const declineRows: Array<{ entity_id: string; tag: string | null; reason: string; at: string }> = [];
  for (const e of ev('action_selector_skip')) {
    if (!e.target_id) continue;
    declineRows.push({
      entity_id: e.target_id,
      tag: (e.payload?.policy as string) ?? null,
      reason: String(e.payload?.reason ?? e.payload?.action ?? 'no action taken'),
      at: e.created_at,
    });
  }
  for (const p of posts) {
    if (p.kind !== 'decision' || !p.channels?.account_entity_id) continue;
    const m = /^\s*\[([^\]]+)\]\s*/.exec(p.body ?? '');
    if (!m || !/draft|outreach|contact/.test(m[1] ?? '')) continue;
    declineRows.push({
      entity_id: p.channels.account_entity_id,
      tag: m[1] ?? null,
      reason: firstSentences((p.body ?? '').slice(m[0].length), 260),
      at: p.created_at,
    });
  }
  declineRows.sort((a, b) => b.at.localeCompare(a.at));

  // ---- Contacts created in the window, assembled from the facts already read.
  const contactIds = facts.filter((f) => f.predicate === 'is_a' && f.object_text === 'contact').map((f) => f.subject_entity);
  const contactSet = new Set(contactIds);
  const roleOf = new Map<string, string>();
  const emailOf = new Map<string, string>();
  const worksAtOf = new Map<string, string>();
  const contactScoreOf = new Map<string, number>();
  for (const f of facts) {
    if (!contactSet.has(f.subject_entity)) continue;
    // works_at points at the employer entity, not a name string.
    if (f.predicate === 'works_at' && f.object_entity) worksAtOf.set(f.subject_entity, f.object_entity);
    if (!f.object_text) continue;
    if (f.predicate === 'role') roleOf.set(f.subject_entity, f.object_text);
    else if (f.predicate === 'email') emailOf.set(f.subject_entity, f.object_text);
    else if (f.predicate === 'contact_score') {
      const v = num(f.object_text);
      if (v !== null) contactScoreOf.set(f.subject_entity, v);
    }
  }
  const accountsWithNewContact = new Set([...worksAtOf.values()]);

  // ---- Round 2: reads that need ids from round 1.
  const moverCandidateIds = scoredIds;
  // Each chunk covers a disjoint slice of ids, so the per-chunk queries below
  // are independent and safe to run concurrently instead of one at a time.
  const [prevScoreFacts, prevBreakdownFacts, signalBodies] = await Promise.all([
    Promise.all(chunk(moverCandidateIds).map((c) => fetchAll<FactRow>((f, t) => sb.from('facts')
      .select('id, predicate, subject_entity, object_text, object_entity, observed_at')
      .eq('workspace_id', ws).eq('predicate', 'icp_fit').in('subject_entity', c)
      .lt('observed_at', since).order('observed_at', { ascending: false }).range(f, t)))).then((r) => r.flat()),
    Promise.all(chunk(moverCandidateIds).map((c) => fetchAll<FactRow>((f, t) => sb.from('facts')
      .select('id, predicate, subject_entity, object_text, object_entity, observed_at')
      .eq('workspace_id', ws).eq('predicate', 'icp_fit_breakdown').in('subject_entity', c)
      .lt('observed_at', since).order('observed_at', { ascending: false }).range(f, t)))).then((r) => r.flat()),
    (async () => {
      // Bodies are ~2KB each, so fetch them only for the signals we render.
      const ids = signals.slice(0, SIGNALS_CAP).map((s) => s.id);
      if (!ids.length) return [] as Array<{ id: string; body_for_embedding: string | null }>;
      const pages = await Promise.all(chunk(ids).map(async (c) => {
        const { data } = await sb.from('signals').select('id, body_for_embedding').in('id', c);
        return (data ?? []) as Array<{ id: string; body_for_embedding: string | null }>;
      }));
      return pages.flat();
    })(),
  ]);

  const prevScoreOf = new Map<string, number>();
  for (const f of prevScoreFacts) { // desc → first seen per entity is the latest-before-window
    if (prevScoreOf.has(f.subject_entity)) continue;
    const v = num(f.object_text);
    if (v !== null) prevScoreOf.set(f.subject_entity, v);
  }
  const prevBreakdownOf = new Map<string, Record<string, unknown>>();
  for (const f of prevBreakdownFacts) {
    if (prevBreakdownOf.has(f.subject_entity) || !f.object_text) continue;
    try { prevBreakdownOf.set(f.subject_entity, JSON.parse(f.object_text) as Record<string, unknown>); } catch { /* skip */ }
  }
  // Current breakdown comes from the window's own facts: no extra query.
  const curBreakdownOf = new Map<string, Record<string, unknown>>();
  for (let i = facts.length - 1; i >= 0; i--) { // walk back: latest wins
    const f = facts[i]!;
    if (f.predicate !== 'icp_fit_breakdown' || curBreakdownOf.has(f.subject_entity) || !f.object_text) continue;
    try { curBreakdownOf.set(f.subject_entity, JSON.parse(f.object_text) as Record<string, unknown>); } catch { /* skip */ }
  }

  // ---- Movers: real movement, fresh signal, or a first score. An idle rescore
  // that changed nothing is noise, not news.
  const researchedIds = new Set(signals.map((s) => s.entity_id).filter(Boolean) as string[]);
  const signalCountOf = new Map<string, number>();
  for (const s of signals) if (s.entity_id) signalCountOf.set(s.entity_id, (signalCountOf.get(s.entity_id) ?? 0) + 1);
  const draftedIds = new Set(draftPosts.map((p) => p.channels?.account_entity_id).filter(Boolean) as string[]);

  const learnedByEntity = new Map<string, Array<{ id: string; predicate: string; object: string; pain: boolean }>>();
  for (const f of learnedFacts) {
    const list = learnedByEntity.get(f.subject_entity) ?? [];
    list.push({
      id: f.id,
      predicate: f.predicate,
      object: (f.object_text ?? '').replace(/\s+/g, ' ').slice(0, 240),
      pain: f.predicate === 'pain_observed',
    });
    learnedByEntity.set(f.subject_entity, list);
  }

  const moverCandidates = scoredIds.map((id) => {
    const scoreNew = newScoreOf.get(id)!;
    const scorePrev = prevScoreOf.has(id) ? prevScoreOf.get(id)! : null;
    return {
      id,
      scoreNew,
      scorePrev,
      delta: scoreNew - (scorePrev ?? 0),
      hasSignal: researchedIds.has(id),
    };
  }).filter((c) => !(Math.abs(c.delta) < 0.01 && !c.hasSignal && c.scorePrev !== null));
  moverCandidates.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const moverSlice = moverCandidates.slice(0, MOVERS_CAP);

  // ---- Names for everything we mention, in one chunked read.
  const wanted = new Set<string>();
  moverSlice.forEach((m) => wanted.add(m.id));
  signals.slice(0, SIGNALS_CAP).forEach((s) => s.entity_id && wanted.add(s.entity_id));
  learnedByEntity.forEach((_v, k) => wanted.add(k));
  contactSet.forEach((id) => wanted.add(id));
  accountsWithNewContact.forEach((id) => wanted.add(id));
  draftPosts.forEach((p) => p.channels?.account_entity_id && wanted.add(p.channels.account_entity_id));
  declineRows.forEach((d) => wanted.add(d.entity_id));
  detailEvents.forEach((e) => e.target_id && wanted.add(e.target_id));
  const nameOf = new Map<string, string>();
  const namePages = await Promise.all(chunk([...wanted]).map(async (c) => {
    const { data } = await sb.from('entities').select('id, name').in('id', c);
    return (data ?? []) as Array<{ id: string; name: string }>;
  }));
  for (const page of namePages) {
    for (const r of page) nameOf.set(r.id, r.name);
  }
  const N = (id: string | null | undefined) => (id && nameOf.get(id)) || (id ?? '?').slice(0, 8);

  const movers: TodayMove[] = moverSlice.map((c) => {
    const cur = curBreakdownOf.get(c.id);
    const prev = prevBreakdownOf.get(c.id);
    let driver: TodayMove['driver'] = null;
    if (cur && prev) {
      for (const k of SUB_SCORE_KEYS) {
        const a = num(prev[k]);
        const b = num(cur[k]);
        if (a === null || b === null || Math.abs(b - a) < 0.01) continue;
        if (!driver || Math.abs(b - a) > Math.abs(driver.next - driver.prev)) driver = { key: k, prev: a, next: b };
      }
      // graph_proximity is a plain mean over neighbor icp_fit facts, so the
      // scorer records exactly which facts drove it (see graph.ts
      // graphProximity/evidence_fact_ids) - surface those so the "moved on
      // network proximity" line can cite them instead of just showing the delta.
      if (driver && driver.key === 'graph_proximity') {
        const ids = (cur as { evidence_fact_ids?: { graph_proximity?: unknown } } | undefined)?.evidence_fact_ids?.graph_proximity;
        if (Array.isArray(ids) && ids.length) driver = { ...driver, fact_ids: ids.filter((x): x is string => typeof x === 'string') };
      }
    }
    const reasoningRaw = typeof cur?.reasoning === 'string' ? cur.reasoning.trim() : '';
    return {
      entity_id: c.id,
      name: N(c.id),
      scorePrev: c.scorePrev,
      scoreNew: c.scoreNew,
      delta: c.delta,
      driver,
      reasoning: reasoningRaw ? firstSentences(cleanReasoning(reasoningRaw), 260) : null,
      claim: claimsOf.get(c.id) ?? null,
      facts: (learnedByEntity.get(c.id) ?? []).slice(0, 4).map((f) => ({ id: f.id, predicate: f.predicate, object: f.object })),
      signals: signalCountOf.get(c.id) ?? 0,
      hasDraft: draftedIds.has(c.id),
      hasContact: accountsWithNewContact.has(c.id),
    };
  });

  // ---- Signals with their metadata.
  const bodyOf = new Map(signalBodies.map((s) => [s.id, s.body_for_embedding ?? '']));
  const todaySignals: TodaySignal[] = signals.slice(0, SIGNALS_CAP)
    .map((s) => toTodaySignal(s, bodyOf, factsBySignal, noFactSignals, skippedSignals, N));

  const angleAgg = new Map<string, { count: number; withFacts: number }>();
  for (const s of signals) {
    const tags = s.structured_tags ?? {};
    const angle = String(tags.research_angle ?? tags.signal_source ?? s.type ?? 'signal');
    const a = angleAgg.get(angle) ?? { count: 0, withFacts: 0 };
    a.count += 1;
    if ((factsBySignal.get(s.id) ?? 0) > 0) a.withFacts += 1;
    angleAgg.set(angle, a);
  }
  const signalAngles = [...angleAgg].map(([angle, v]) => ({ angle, ...v })).sort((a, b) => b.count - a.count);

  // ---- What the agent learned, by account, best-covered accounts first.
  const learnedAll = [...learnedByEntity].map(([id, fs]) => ({
    entity_id: id,
    name: N(id),
    facts: fs.slice(0, 6),
  })).sort((a, b) => {
    const pa = a.facts.some((f) => f.pain) ? 1 : 0;
    const pb = b.facts.some((f) => f.pain) ? 1 : 0;
    return pb - pa || b.facts.length - a.facts.length;
  });

  // ---- Runs: cluster each job's events into the passes that produced them.
  const runs: TodayRun[] = [];
  const researchEvents = [...ev('research_completed'), ...ev('research_error')];
  for (const block of clusterByGap(researchEvents, (e) => e.created_at)) {
    const completed = block.filter((e) => e.action === 'research_completed');
    const errored = block.filter((e) => e.action === 'research_error');
    const startedAt = block[0]!.created_at;
    const endedAt = block[block.length - 1]!.created_at;
    // The enricher and scorer react to this pass's signals within minutes, so
    // fold their output into the same block by timestamp (10-minute tail).
    const blockEnd = Date.parse(endedAt) + 10 * 60_000;
    const inBlock = (iso: string) => Date.parse(iso) >= Date.parse(startedAt) && Date.parse(iso) <= blockEnd;
    const blockLearnedFacts = learnedFacts.filter((f) => inBlock(f.observed_at));
    const blockFacts = blockLearnedFacts.length;
    const blockScored = new Set(facts.filter((f) => f.predicate === 'icp_fit' && inBlock(f.observed_at)).map((f) => f.subject_entity)).size;
    const blockSignals = signals.filter((s) => inBlock(s.created_at));
    const searches = completed.reduce((n, e) => n + (e.payload?.searches ?? 0), 0);
    const results = completed.reduce((n, e) => n + (e.payload?.results_created ?? 0), 0);
    const accountIds = [...new Set(block.map((e) => e.target_id).filter(Boolean) as string[])];
    runs.push({
      id: `research-${startedAt}`,
      kind: 'research',
      label: 'Research sweep',
      startedAt,
      endedAt,
      stats: [
        { label: plural(accountIds.length, 'company', 'companies'), value: String(accountIds.length) },
        { label: plural(searches, 'search', 'searches'), value: String(searches) },
        { label: `new ${plural(results, 'article')}`, value: String(results) },
        { label: `${plural(blockFacts, 'fact')} learned`, value: String(blockFacts) },
        { label: 'rescored', value: String(blockScored) },
      ],
      accounts: accountIds.slice(0, 6).map((id) => ({ id, name: N(id) })),
      accountsMore: Math.max(0, accountIds.length - 6),
      errors: [...new Set(errored.map((e) => plainError(String(e.payload?.message ?? 'research failed'))))],
      ok: errored.length === 0,
      learned: groupFactsByEntity(blockLearnedFacts, N).slice(0, RUN_LEARNED_ENTITIES_CAP),
      signals: blockSignals.slice(0, RUN_SIGNALS_CAP).map((s) => toTodaySignal(s, bodyOf, factsBySignal, noFactSignals, skippedSignals, N)),
      contacts: [],
      drafts: [],
      declines: [],
      domains: [],
    });
  }

  // Contacts and drafting are one scheduled pass (the daily advance): it pulls
  // contacts for the best accounts, then decides whether to write to them.
  const outreachEvents = [
    ...ev('contacts_completed').map((e) => ({ ...e, _k: 'contact' as const })),
    ...ev('create_contact').map((e) => ({ ...e, _k: 'contact_created' as const })),
    ...draftPosts.map((p) => ({ action: 'draft', created_at: p.created_at, target_id: p.channels?.account_entity_id ?? null, payload: null, _k: 'draft' as const })),
    ...declineRows.map((d) => ({ action: 'decline', created_at: d.at, target_id: d.entity_id, payload: null, _k: 'decline' as const })),
  ];
  for (const block of clusterByGap(outreachEvents, (e) => e.created_at)) {
    const pulls = block.filter((e) => e._k === 'contact');
    const created = block.filter((e) => e._k === 'contact_created');
    const drafted = block.filter((e) => e._k === 'draft');
    const declined = block.filter((e) => e._k === 'decline');
    const startedAt = block[0]!.created_at;
    const endedAt = block[block.length - 1]!.created_at;
    const accountIds = [...new Set(block.map((e) => e.target_id).filter(Boolean) as string[])];
    const failReasons = new Map<string, number>();
    for (const p of pulls) {
      const s = String(p.payload?.summary ?? '');
      if (s && !/new contact/.test(s)) failReasons.set(s, (failReasons.get(s) ?? 0) + 1);
    }
    // Re-filter the strongly-typed source rows by the same window, rather than
    // reading them off the polymorphic `block` array (drafted/declined there
    // are shape-erased placeholders built just for clustering).
    const blockContactIds = [...new Set(created.map((e) => e.target_id).filter(Boolean) as string[])];
    const blockDrafts = draftPosts.filter((p) => p.created_at >= startedAt && p.created_at <= endedAt);
    const blockDeclines = declineRows.filter((d) => d.at >= startedAt && d.at <= endedAt);
    runs.push({
      id: `outreach-${startedAt}`,
      kind: 'outreach',
      label: 'Contacts and outreach pass',
      startedAt,
      endedAt,
      stats: [
        { label: plural(accountIds.length, 'company', 'companies'), value: String(accountIds.length) },
        { label: `contact ${plural(pulls.length, 'lookup')}`, value: String(pulls.length) },
        { label: plural(created.length, 'person', 'people'), value: String(created.length) },
        { label: `${plural(drafted.length, 'message')} written`, value: String(drafted.length) },
        { label: 'passed on', value: String(declined.length) },
      ],
      accounts: accountIds.slice(0, 6).map((id) => ({ id, name: N(id) })),
      accountsMore: Math.max(0, accountIds.length - 6),
      errors: [...failReasons].filter(([r]) => /key|error|quota|credit/i.test(r)).map(([r, n]) => `${n}× ${r}`),
      ok: true,
      learned: [],
      signals: [],
      contacts: blockContactIds.slice(0, RUN_CONTACTS_CAP).map((id) => toTodayContact(id, roleOf, emailOf, worksAtOf, contactScoreOf, N)),
      drafts: blockDrafts.slice(0, RUN_DRAFTS_CAP).map((p) => toTodayDraft(p, reasoningByParent, pendingPostIds, N)),
      declines: blockDeclines.slice(0, RUN_DECLINES_CAP).map((d) => toTodayDecline(d, N)),
      domains: [],
    });
  }

  const domainEvents = [...ev('domain_resolved'), ...ev('domain_resolve_failed')];
  for (const block of clusterByGap(domainEvents, (e) => e.created_at)) {
    const resolved = block.filter((e) => e.action === 'domain_resolved');
    const okCount = resolved.length;
    const failCount = block.length - okCount;
    const startedAt = block[0]!.created_at;
    runs.push({
      id: `domains-${startedAt}`,
      kind: 'domains',
      label: 'Website lookup',
      startedAt,
      endedAt: block[block.length - 1]!.created_at,
      stats: [
        { label: `${plural(block.length, 'company', 'companies')} looked up`, value: String(block.length) },
        { label: 'websites found', value: String(okCount) },
        { label: 'no confident match', value: String(failCount) },
      ],
      accounts: resolved.slice(0, 6).map((e) => ({ id: e.target_id ?? '', name: N(e.target_id) })),
      accountsMore: Math.max(0, okCount - 6),
      errors: [],
      ok: true,
      learned: [],
      signals: [],
      contacts: [],
      drafts: [],
      declines: [],
      domains: resolved.slice(0, RUN_DOMAINS_CAP).map((e) => ({
        entity_id: e.target_id ?? '',
        name: N(e.target_id),
        domain: String(e.payload?.domain ?? ''),
      })),
    });
  }

  for (const e of ev('retention_run')) {
    runs.push({
      id: `retention-${e.created_at}`,
      kind: 'maintenance',
      label: 'Storage cleanup',
      startedAt: e.created_at,
      endedAt: e.created_at,
      stats: [
        { label: 'old events pruned', value: String(e.payload?.events_pruned ?? 0) },
        { label: 'embeddings archived', value: String(e.payload?.embeddings_archived ?? 0) },
      ],
      accounts: [],
      accountsMore: 0,
      errors: [],
      ok: true,
      learned: [],
      signals: [],
      contacts: [],
      drafts: [],
      declines: [],
      domains: [],
    });
  }
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  // ---- Spend. Token metrics only exist for behaviors that record them, so the
  // LLM figure is a floor, not a full bill.
  const pricing: Pricing = {
    ...DEFAULT_PRICING,
    ...(policy.report?.pricing ?? {}),
    models: { ...DEFAULT_PRICING.models, ...(policy.report?.pricing?.models ?? {}) },
  };
  const modelAgg = new Map<string, { behaviors: Set<string>; runs: number; input: number; cached: number; output: number }>();
  for (const e of ev('agent_run_metrics')) {
    const model = String(e.payload?.model ?? 'unknown').split('/').pop()!;
    const m = modelAgg.get(model) ?? { behaviors: new Set<string>(), runs: 0, input: 0, cached: 0, output: 0 };
    m.behaviors.add(String(e.payload?.behavior ?? 'other'));
    m.runs += 1;
    m.input += e.payload?.input_tokens ?? 0;
    m.cached += e.payload?.cached_input_tokens ?? 0;
    m.output += e.payload?.output_tokens ?? 0;
    modelAgg.set(model, m);
  }
  let llmUsd = 0;
  const byModel = [...modelAgg].map(([model, m]) => {
    const rate = pricing.models[model];
    const usd = rate
      ? ((m.input - m.cached) / 1e6) * rate.input + (m.cached / 1e6) * rate.cached + (m.output / 1e6) * rate.output
      : null;
    if (usd !== null) llmUsd += usd;
    return { model, behaviors: [...m.behaviors], runs: m.runs, input: m.input, cached: m.cached, output: m.output, usd };
  }).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));

  const searchesTotal = ev('research_completed').reduce((n, e) => n + (e.payload?.searches ?? 0), 0);
  const domainsResolved = ev('domain_resolved').length;
  const domainsFailed = ev('domain_resolve_failed').length;
  const exaSearches = searchesTotal + domainsResolved + domainsFailed;
  const exaUsd = exaSearches * pricing.exa_per_search + exaSearches * pricing.exa_avg_pages_per_search * pricing.exa_per_content_page;
  const totalUsd = llmUsd + exaUsd;
  const spend: TodaySpend = {
    byModel,
    exa: { searches: exaSearches, usd: exaUsd },
    llmUsd,
    totalUsd,
    perDayUsd: (totalUsd * 24) / WINDOW_HOURS,
  };

  // ---- Connectors: configured state plus what each one actually did today.
  const envPresent = new Set(
    Object.entries((policy.env ?? {}) as Record<string, string>)
      .filter(([, v]) => typeof v === 'string' && v.length > 0).map(([k]) => k),
  );
  const serverEnvPresent = new Set(
    CONNECTORS.flatMap((c) => c.fields).map((f) => f.key)
      .filter((k) => typeof process.env[k] === 'string' && process.env[k]!.length > 0),
  );
  const policyValues: Record<string, unknown> = {};
  for (const c of CONNECTORS) {
    for (const f of c.fields) if (f.policy_path) policyValues[f.policy_path] = getPath(policy, f.policy_path);
  }
  const resolveInput: ResolveStateInput = {
    envPresent,
    serverEnvPresent,
    policyValues,
    contactPrimary: policy.enrichment?.contact_provider,
    contactFallback: policy.enrichment?.contact_provider_fallback,
    pipeline: (policy.pipeline ?? null) as ResolveStateInput['pipeline'],
  };
  const contactPullsByProvider = new Map<string, number>();
  for (const e of ev('contacts_completed')) {
    const s = String(e.payload?.summary ?? '').toLowerCase();
    for (const c of CONNECTORS) {
      if (c.provider_id && s.includes(c.provider_id)) {
        contactPullsByProvider.set(c.provider_id, (contactPullsByProvider.get(c.provider_id) ?? 0) + 1);
      }
    }
  }
  const modelRunsByProvider = new Map<string, number>();
  for (const e of ev('agent_run_metrics')) {
    const p = String(e.payload?.provider ?? '').toLowerCase();
    if (p) modelRunsByProvider.set(p, (modelRunsByProvider.get(p) ?? 0) + 1);
  }
  const sendCount = posts.filter((p) => p.kind === 'system' && /^Sent →/.test(p.body ?? '')).length;

  const connectors: TodayConnector[] = CONNECTORS.map((def) => {
    const state = resolveConnectorState(def, resolveInput);
    let usage: string | null = null;
    if (def.category === 'model') {
      const n = modelRunsByProvider.get(def.id) ?? 0;
      if (n) usage = `${n} model call${n === 1 ? '' : 's'} today`;
    } else if (def.category === 'contact' && def.provider_id) {
      const n = contactPullsByProvider.get(def.provider_id) ?? 0;
      if (n) usage = `${n} lookup${n === 1 ? '' : 's'} today`;
    } else if (def.category === 'research') {
      if (exaSearches) usage = `${exaSearches} searches today`;
    } else if (def.category === 'email') {
      if (sendCount) usage = `${sendCount} send${sendCount === 1 ? '' : 's'} today`;
    }
    return {
      id: def.id,
      name: def.name,
      category: def.category,
      health: state.health,
      role: state.role,
      missing: state.missing_keys.map((k) => def.fields.find((f) => f.key === k)?.label ?? k),
      fromServer: state.from_server.length > 0,
      alert: state.alert?.message ?? null,
      usage,
    };
  });

  // ---- Sources: is each one running on the cadence it declares?
  const now = Date.now();
  const sources: TodaySource[] = ((sourceRows.data ?? []) as SourceRow[]).map((s) => {
    const intervalMin = cronToMinIntervalMinutes(s.schedule_cron);
    const ageMin = s.last_run_at ? (now - Date.parse(s.last_run_at)) / 60_000 : Infinity;
    const sum = s.last_run_summary ?? {};
    const errs = Array.isArray(sum.errors) ? (sum.errors as unknown[]).map(String).filter(Boolean) : [];
    const parts: string[] = [];
    if (typeof sum.signals_created === 'number') parts.push(`${sum.signals_created} new signals`);
    if (typeof sum.entities_created === 'number' && sum.entities_created > 0) parts.push(`${sum.entities_created} new companies`);
    if (typeof sum.skipped === 'number' && sum.skipped > 0) parts.push(`${sum.skipped} skipped`);
    return {
      id: s.id,
      name: s.name,
      type: s.connector_type,
      active: s.active,
      lastRunAt: s.last_run_at,
      status: s.last_run_status,
      summary: parts.join(' · ') || 'no detail recorded',
      error: errs.length ? firstSentences(errs.join('; '), 200) : null,
      overdue: s.active && ageMin > intervalMin * 3,
      signals7d: typeof sum.signals_7d === 'number' ? sum.signals_7d : 0,
    };
  });

  // ---- Approvals.
  const pendingList = (pendingGates.data ?? []) as GateRow[];
  const decidedList = (decidedGates.data ?? []) as GateRow[];
  const decided: TodayDecided[] = decidedList.slice(0, 10).map((g) => ({
    entity_name: String(g.condition?.entity_name ?? 'an account'),
    decision: g.decision ?? 'decided',
    at: g.decided_at ?? g.requested_at,
    edited: Boolean(g.resolution?.edited),
  }));

  const drafts: TodayDraft[] = draftPosts.slice(-10).reverse().map((p) => toTodayDraft(p, reasoningByParent, pendingPostIds, N));

  // ---- Counters.
  const scoreUp = moverCandidates.filter((c) => c.scorePrev !== null && c.delta > 0.01).length;
  const scoreDown = moverCandidates.filter((c) => c.scorePrev !== null && c.delta < -0.01).length;
  const counters: TodayCounters = {
    // Passes, not per-account tasks: one sweep works through many accounts.
    researchRuns: runs.filter((r) => r.kind === 'research').length,
    searches: searchesTotal,
    signals: signals.length,
    accountsResearched: researchedIds.size,
    factsLearned: learnedFacts.length,
    painsFound: learnedFacts.filter((f) => f.predicate === 'pain_observed').length,
    accountsScored: scoredIds.length,
    scoreUp,
    scoreDown,
    contactPulls: ev('contacts_completed').length,
    contactsFound: contactIds.length,
    draftsWritten: draftPosts.length,
    draftsDeclined: declineRows.length,
    approvalsPending: pendingList.length,
    approvalsDecided: decidedList.length,
    domainsResolved,
    domainsFailed,
    signalsPassedOver: countOf('enrichment_skipped') + countOf('enrichment_no_facts'),
    spendUsd: totalUsd,
    spendPerDayUsd: spend.perDayUsd,
  };

  // ---- What needs attention. Blocking things first, each with somewhere to go.
  // A pause is already the loudest thing on the page: PipelineBanner renders it
  // above this section on every route, with the Continue button. Repeating it
  // here (and again as the connector that caused it) would say the same sentence
  // three times, so alerts only carry what the banner does not cover.
  const alerts: TodayAlert[] = [];
  for (const c of connectors) {
    if (c.alert && !pipeline.paused) {
      alerts.push({
        id: `connector_${c.id}`,
        severity: 'red',
        title: `${c.name} stopped working`,
        detail: c.alert,
        href: `/workspace/${ws}/settings/connectors`,
        hrefLabel: 'Fix it',
      });
    }
  }
  for (const s of sources) {
    if (s.active && s.status && s.status !== 'ok') {
      alerts.push({
        id: `source_${s.id}`,
        severity: 'amber',
        title: `${s.name} failed its last run`,
        detail: s.error ?? s.summary,
        href: `/workspace/${ws}/sources`,
        hrefLabel: 'Open sources',
      });
    } else if (s.overdue) {
      alerts.push({
        id: `source_stale_${s.id}`,
        severity: 'amber',
        title: `${s.name} has not run on schedule`,
        detail: s.lastRunAt ? `Last run ${new Date(s.lastRunAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : 'It has never run.',
        href: `/workspace/${ws}/sources`,
        hrefLabel: 'Open sources',
      });
    }
  }
  const oldestPending = pendingList[0];
  if (oldestPending && Date.now() - Date.parse(oldestPending.requested_at) > 3 * 86400e3) {
    const days = Math.floor((Date.now() - Date.parse(oldestPending.requested_at)) / 86400e3);
    alerts.push({
      id: 'stale_approval',
      severity: 'amber',
      title: `A message has been waiting ${days} days`,
      detail: `${pendingList.length} message${pendingList.length === 1 ? '' : 's'} still need${pendingList.length === 1 ? 's' : ''} your yes or no.`,
      href: null,
      hrefLabel: null,
    });
  }
  if (!pipeline.paused && counters.signals === 0 && counters.researchRuns === 0) {
    alerts.push({
      id: 'no_research',
      severity: 'amber',
      title: 'No research ran in the last 24 hours',
      detail: 'The agent found nothing new. Check that a research provider is connected and a source is active.',
      href: `/workspace/${ws}/sources`,
      hrefLabel: 'Open sources',
    });
  }

  return {
    window,
    generatedAt: until,
    pipeline,
    counters,
    alerts,
    runs,
    movers,
    moversMore: Math.max(0, moverCandidates.length - movers.length),
    signals: todaySignals,
    signalsMore: Math.max(0, signals.length - todaySignals.length),
    signalAngles,
    learned: learnedAll.slice(0, LEARNED_CAP),
    learnedMore: Math.max(0, learnedAll.length - LEARNED_CAP),
    contacts: [...contactSet].slice(0, CONTACTS_CAP).map((id) => toTodayContact(id, roleOf, emailOf, worksAtOf, contactScoreOf, N)),
    drafts,
    declines: declineRows.slice(0, DECLINES_CAP).map((d) => toTodayDecline(d, N)),
    decided,
    connectors,
    sources,
    spend,
  };
};

export const getTodayData = unstable_cache(_getTodayData, ['today-data'], {
  revalidate: 120,
  tags: ['feed', 'today'],
});

// ---------------------------------------------------------------- trend

/**
 * Two weeks of daily throughput, for the "is the machine speeding up or slowing
 * down" chart. Three cheap column-only reads; cached far longer than the page
 * itself because a multi-day read has no business running every two minutes.
 */
const _getTodayTrend = async (ws: string): Promise<TodayTrendPoint[]> => {
  const sb = createServerClient();
  const days = 14;
  const since = new Date(Date.now() - days * 86400e3).toISOString();

  const [signalDays, scoreDays, draftDays] = await Promise.all([
    fetchAll<{ created_at: string }>((f, t) => sb.from('signals').select('created_at')
      .eq('workspace_id', ws).gte('created_at', since).range(f, t)),
    fetchAll<{ subject_entity: string; observed_at: string }>((f, t) => sb.from('facts').select('subject_entity, observed_at')
      .eq('workspace_id', ws).eq('predicate', 'icp_fit').gte('observed_at', since).range(f, t)),
    fetchAll<{ created_at: string }>((f, t) => sb.from('channel_posts')
      .select('created_at, channels!inner(workspace_id)')
      .eq('channels.workspace_id', ws).eq('kind', 'touch_draft').gte('created_at', since).range(f, t) as unknown as PromiseLike<{ data: Array<{ created_at: string }> | null; error: { message: string } | null }>),
  ]);

  const out: TodayTrendPoint[] = [];
  const scoredPerDay = new Map<string, Set<string>>();
  for (const s of scoreDays) {
    const d = s.observed_at.slice(0, 10);
    const set = scoredPerDay.get(d) ?? new Set<string>();
    set.add(s.subject_entity);
    scoredPerDay.set(d, set);
  }
  const sigPerDay = new Map<string, number>();
  for (const s of signalDays) sigPerDay.set(s.created_at.slice(0, 10), (sigPerDay.get(s.created_at.slice(0, 10)) ?? 0) + 1);
  const draftPerDay = new Map<string, number>();
  for (const s of draftDays) draftPerDay.set(s.created_at.slice(0, 10), (draftPerDay.get(s.created_at.slice(0, 10)) ?? 0) + 1);

  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
    out.push({
      day,
      signals: sigPerDay.get(day) ?? 0,
      scored: scoredPerDay.get(day)?.size ?? 0,
      drafts: draftPerDay.get(day) ?? 0,
    });
  }
  return out;
};

export const getTodayTrend = unstable_cache(_getTodayTrend, ['today-trend'], {
  revalidate: 900,
  tags: ['today'],
});
