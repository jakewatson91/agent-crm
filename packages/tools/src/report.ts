/**
 * Period digest — everything the platform did in a time window, per workspace.
 *
 * Split into three pieces so the same logic serves the CLI now and an API route
 * later:
 *   resolvePeriod()  — turn CLI-ish inputs (--since/--until/--period/--hours)
 *                      into a concrete { since, until } window.
 *   collectPeriod()  — every DB read. Returns a plain PeriodData object (JSON
 *                      serializable, no Maps) so a live route can hand it to the
 *                      browser and render there.
 *   renderMarkdown() — pure function PeriodData -> markdown. No DB calls.
 *
 * The centerpiece is PeriodData.moves: for each account scored in the window it
 * joins the score change to the signals that drove it and the draft that came
 * out, so "what moved and why" reads as one story instead of three sections you
 * mentally stitch together.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll } from './paginate.ts';
import { entityIdsOfType } from './entity_types.ts';
import { isSubstantiveFact } from './scoring.ts';
import { sweepWorkspace, type CheckResult } from './sweep.ts';

// ---------- pricing (unchanged from the old daily_report) ----------

export interface Pricing {
  models: Record<string, { input: number; cached: number; output: number }>;
  exa_per_search: number;
  exa_per_content_page: number;
  exa_avg_pages_per_search: number;
  hunter_per_search: number;
}

// Per-unit costs in USD, provider list prices as of 2026-07. Override via
// workspaces.policy.report.pricing (same shape). Token rates are per 1M tokens;
// "input" is the cache-miss rate, "cached" the cache-hit rate.
export const DEFAULT_PRICING: Pricing = {
  models: {
    'deepseek-v4-flash': { input: 0.14, cached: 0.0028, output: 0.28 },
    'deepseek-v4-pro': { input: 0.435, cached: 0.003625, output: 0.87 },
  },
  exa_per_search: 0.007, // $7 / 1k requests (1-10 results)
  exa_per_content_page: 0.001, // $1 / 1k pages; each search retrieves ~num_results pages
  exa_avg_pages_per_search: 3,
  hunter_per_search: 0, // current plan: monthly credits, no overage: cost is credits, not dollars
};

// ---------- window resolution ----------

export interface PeriodWindow {
  since: string; // ISO
  until: string; // ISO
  label: string; // human label, e.g. "last 24h" or "2026-07-01 → 2026-07-08"
  hours: number; // window length in hours (rate math + comparisons)
}

// Accept either a full ISO string or a bare YYYY-MM-DD. A bare date resolves to
// UTC midnight (start of that day) or, for the upper bound, the next midnight so
// the day is fully included.
function parseBoundary(s: string, endExclusive = false): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, dd] = s.split('-');
    const base = Date.UTC(Number(y), Number(m) - 1, Number(dd) + (endExclusive ? 1 : 0));
    return new Date(base).toISOString();
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new Error(`Unparseable date: "${s}" (use ISO or YYYY-MM-DD)`);
  return new Date(t).toISOString();
}

function startOfUTCDay(d: Date, dayOffset = 0): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dayOffset)).toISOString();
}

/**
 * Resolve a window from any mix of inputs. Precedence: explicit since/until >
 * period preset > hours (default 24). now is injectable for tests.
 */
export function resolvePeriod(opts: {
  since?: string;
  until?: string;
  period?: string;
  hours?: number;
  now?: Date;
}): PeriodWindow {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const mk = (since: string, until: string, label: string): PeriodWindow => ({
    since,
    until,
    label,
    hours: Math.max(0, (Date.parse(until) - Date.parse(since)) / 3600e3),
  });

  // 1) Explicit range. The upper bound is exclusive (a bare date includes the
  // whole day), but the label shows the inclusive dates the user typed so
  // "--until 2026-07-20" doesn't read as ending on the 21st.
  if (opts.since || opts.until) {
    const until = opts.until ? parseBoundary(opts.until, true) : nowIso;
    const since = opts.since ? parseBoundary(opts.since) : new Date(Date.parse(until) - 24 * 3600e3).toISOString();
    const labelUntil = opts.until ? opts.until.slice(0, 10) : until.slice(0, 10);
    const label = `${(opts.since ?? since).slice(0, 10)} → ${labelUntil}`;
    return mk(since, until, label);
  }

  // 2) Named preset.
  if (opts.period) {
    const p = opts.period.trim().toLowerCase();
    if (p === 'today') return mk(startOfUTCDay(now), nowIso, 'today (UTC)');
    if (p === 'yesterday') return mk(startOfUTCDay(now, -1), startOfUTCDay(now), 'yesterday (UTC)');
    const nd = /^(\d+)\s*d$/.exec(p);
    if (p === 'week' || p === '7d' || (nd && Number(nd[1]) === 7)) return mk(new Date(now.getTime() - 7 * 24 * 3600e3).toISOString(), nowIso, 'last 7d');
    if (p === 'month' || p === '30d' || (nd && Number(nd[1]) === 30)) return mk(new Date(now.getTime() - 30 * 24 * 3600e3).toISOString(), nowIso, 'last 30d');
    if (nd) {
      const days = Number(nd[1]);
      return mk(new Date(now.getTime() - days * 24 * 3600e3).toISOString(), nowIso, `last ${days}d`);
    }
    throw new Error(`Unknown period "${opts.period}". Use today|yesterday|7d|30d|<N>d, or --since/--until.`);
  }

  // 3) Rolling hours (back-compat default).
  const hours = opts.hours && opts.hours > 0 ? opts.hours : 24;
  return mk(new Date(now.getTime() - hours * 3600e3).toISOString(), nowIso, `last ${hours}h`);
}

// ---------- collected data shape ----------

interface EventRow { action: string; created_at: string; payload: any; target_id: string | null }
interface SignalRow { id: string; entity_id: string | null; magnitude: number | null; body_for_embedding: string | null; structured_tags: any; created_at: string }
interface FactRow { predicate: string; subject_entity: string; object_text: string | null; observed_at: string }
interface PostRow { kind: string; created_at: string; body: string | null; channel_id: string }
interface GateLite { id: string; policy: string; condition?: any; requested_at?: string; decision?: string | null; decided_at?: string; resolution?: any }

/** One account's story: score change joined to the signals and draft behind it. */
export interface EntityMove {
  entity_id: string;
  name: string;
  scorePrev: number | null; // null = first score in this window
  scoreNew: number;
  scoreDelta: number; // scoreNew - (scorePrev ?? 0)
  topSubMove: { name: string; prev: number; next: number } | null; // biggest sub-score change vs before the window
  subScores: Record<string, number> | null; // current dimensions, for the first-score cohort
  reasoning: string | null; // scorer's plain-language why, from icp_fit_breakdown
  signals: Array<{ angle: string; magnitude: number | null; body: string; url: string | null; at: string }>;
  newFacts: Array<{ predicate: string; object: string; at: string }>;
  drafted: { body: string; at: string } | null;
}

export interface PeriodData {
  workspace: { id: string; name: string };
  window: PeriodWindow;
  policy: any;
  pricing: Pricing;
  pipelineStatus: string;
  nameOf: Record<string, string>;
  accountOfChannel: Record<string, string>;
  events: EventRow[];
  signals: SignalRow[];
  facts: FactRow[];
  posts: PostRow[];
  moves: EntityMove[];
  movesTruncated: number; // candidates beyond the rendered cap
  prevScoreOf: Record<string, string>; // entity -> last icp_fit before the window (for the movers list)
  approvals: { pending: GateLite[]; decided: GateLite[] };
  domainBackfill: { remaining: number; perDay: number } | null;
  advance: AdvanceSummary | null;
  rescoring: Rescoring;
  health: { checks: CheckResult[]; prevRedIds: string[] | null; checkedAt: string } | null;
}

/** The advance pass, summed over every run in the window. This is the account
 *  side of the day: what the pass looked at and why most of it went nowhere. */
export interface AdvanceSummary {
  runs: number;
  scanned: number;
  contacts_pulled: number;
  contacts_created: number;
  drafts_created: number;
  decisions: Record<string, number>;
  examples: Record<string, string[]>;
  paused: string[];
}

/** Score writes that re-answered a question already answered. A write is
 *  redundant when its inputs_hash matches the previous write's: same facts,
 *  same ICP, same about text, so the rubric was asked to re-judge identical
 *  evidence. Counting these is how you catch a scoring loop burning tokens to
 *  land on the same number. */
export interface Rescoring {
  writes: number;
  entities: number;
  redundant: number;
  offenders: Array<{ name: string; writes: number; redundant: number }>;
}

const SUB_SCORE_KEYS = ['industry_match', 'stage_match', 'signal_strength', 'evidence_depth', 'recency', 'graph_proximity'] as const;
const MOVES_RENDER_CAP = 20;

// ---------- collection (all DB reads live here) ----------

export async function collectPeriod(sb: SupabaseClient, wsId: string, wsName: string, window: PeriodWindow): Promise<PeriodData> {
  const { since, until } = window;

  const events = await fetchAll<EventRow>((f, t) =>
    sb.from('events').select('action, created_at, payload, target_id').eq('workspace_id', wsId).gte('created_at', since).lt('created_at', until).order('created_at', { ascending: true }).range(f, t));

  const signals = await fetchAll<SignalRow>((f, t) =>
    sb.from('signals').select('id, entity_id, magnitude, body_for_embedding, structured_tags, created_at').eq('workspace_id', wsId).gte('created_at', since).lt('created_at', until).range(f, t));

  const facts = await fetchAll<FactRow>((f, t) =>
    sb.from('facts').select('predicate, subject_entity, object_text, observed_at').eq('workspace_id', wsId).gte('observed_at', since).lt('observed_at', until).order('observed_at', { ascending: true }).range(f, t));

  const channels = await fetchAll<{ id: string; account_entity_id: string }>((f, t) =>
    sb.from('channels').select('id, account_entity_id').eq('workspace_id', wsId).range(f, t));
  const accountOfChannel: Record<string, string> = {};
  channels.forEach((c) => { accountOfChannel[c.id] = c.account_entity_id; });

  const posts: PostRow[] = [];
  const channelIds = channels.map((c) => c.id);
  for (let i = 0; i < channelIds.length; i += 150) {
    const { data, error } = await sb.from('channel_posts').select('kind, created_at, body, channel_id').in('channel_id', channelIds.slice(i, i + 150)).gte('created_at', since).lt('created_at', until);
    if (error) throw error;
    posts.push(...((data ?? []) as PostRow[]));
  }
  posts.sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Names for everything we mention.
  const wanted = new Set<string>();
  signals.forEach((s) => s.entity_id && wanted.add(s.entity_id));
  facts.forEach((f) => wanted.add(f.subject_entity));
  events.forEach((e) => e.target_id && wanted.add(e.target_id));
  posts.forEach((p) => { const a = accountOfChannel[p.channel_id]; if (a) wanted.add(a); });
  const nameOf: Record<string, string> = {};
  const ids = [...wanted].filter(Boolean);
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from('entities').select('id, name').in('id', ids.slice(i, i + 200));
    (data ?? []).forEach((e: any) => { nameOf[e.id] = e.name; });
  }
  const N = (id: string | null | undefined) => (id && nameOf[id]) ?? (id ?? '?').slice(0, 8);

  const { data: wsRow } = await sb.from('workspaces').select('policy').eq('id', wsId).maybeSingle();
  const policy = (wsRow?.policy ?? {}) as any;
  const pricing: Pricing = {
    ...DEFAULT_PRICING,
    ...(policy.report?.pricing ?? {}),
    models: { ...DEFAULT_PRICING.models, ...(policy.report?.pricing?.models ?? {}) },
  };
  const pipelineStatus = policy.pipeline?.status ? `${policy.pipeline.status} (${policy.pipeline.reason ?? ''})` : 'running';

  // ---- score movers: prev value before the window, per account scored inside it ----
  const scoreFacts = facts.filter((f) => f.predicate === 'icp_fit');
  const byEntity = new Map<string, FactRow[]>();
  scoreFacts.forEach((f) => { const a = byEntity.get(f.subject_entity) ?? []; a.push(f); byEntity.set(f.subject_entity, a); });
  const prevScoreOf: Record<string, string> = {};
  for (const ent of byEntity.keys()) {
    const { data } = await sb.from('facts').select('object_text').eq('workspace_id', wsId).eq('subject_entity', ent).eq('predicate', 'icp_fit').lt('observed_at', since).order('observed_at', { ascending: false }).limit(1);
    if (data?.[0]?.object_text != null) prevScoreOf[ent] = data[0].object_text;
  }

  // ---- moves: join score change -> signals -> draft, per account ----
  const signalsByEntity = new Map<string, SignalRow[]>();
  signals.forEach((s) => { if (!s.entity_id) return; const a = signalsByEntity.get(s.entity_id) ?? []; a.push(s); signalsByEntity.set(s.entity_id, a); });
  const factsByEntity = new Map<string, FactRow[]>();
  facts.forEach((f) => { if (!isSubstantiveFact(f.predicate)) return; const a = factsByEntity.get(f.subject_entity) ?? []; a.push(f); factsByEntity.set(f.subject_entity, a); });
  const draftByEntity = new Map<string, PostRow>();
  posts.filter((p) => p.kind === 'touch_draft').forEach((p) => { const ent = accountOfChannel[p.channel_id]; if (ent) draftByEntity.set(ent, p); }); // sorted asc, so this ends on the latest

  const candidates: EntityMove[] = [];
  for (const [ent, rows] of byEntity) {
    const scoreNew = parseFloat(rows[rows.length - 1]?.object_text ?? '');
    if (!Number.isFinite(scoreNew)) continue;
    const prevRaw = prevScoreOf[ent];
    const scorePrev = prevRaw != null && Number.isFinite(parseFloat(prevRaw)) ? parseFloat(prevRaw) : null;
    const scoreDelta = scoreNew - (scorePrev ?? 0);
    const sigs = (signalsByEntity.get(ent) ?? []).map((s) => {
      const tags = s.structured_tags ?? {};
      return { angle: tags.research_angle ?? tags.signal_source ?? 'signal', magnitude: s.magnitude, body: (s.body_for_embedding ?? '').replace(/\s+/g, ' ').slice(0, 240), url: tags.url ?? null, at: s.created_at };
    });
    // Drop rescored-but-idle accounts: keep only real movement, fresh signal, or a first score.
    if (Math.abs(scoreDelta) < 0.01 && sigs.length === 0 && scorePrev !== null) continue;
    const nf = (factsByEntity.get(ent) ?? []).map((f) => ({ predicate: f.predicate, object: (f.object_text ?? '').slice(0, 200), at: f.observed_at }));
    const dp = draftByEntity.get(ent);
    candidates.push({
      entity_id: ent, name: N(ent), scorePrev, scoreNew, scoreDelta,
      topSubMove: null, subScores: null, reasoning: null, signals: sigs, newFacts: nf,
      drafted: dp ? { body: (dp.body ?? '').replace(/\n/g, ' '), at: dp.created_at } : null,
    });
  }
  candidates.sort((a, b) => Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta));
  const moves = candidates.slice(0, MOVES_RENDER_CAP);
  const movesTruncated = Math.max(0, candidates.length - moves.length);

  // Enrich only the rendered slice with the breakdown reasoning + biggest sub-move.
  for (const m of moves) {
    const cur = await latestBreakdown(sb, wsId, m.entity_id, until, false);
    m.reasoning = typeof cur?.reasoning === 'string' ? cur.reasoning : null;
    if (cur) {
      const dims: Record<string, number> = {};
      for (const k of SUB_SCORE_KEYS) { const v = num(cur[k]); if (v != null) dims[k] = v; }
      m.subScores = Object.keys(dims).length ? dims : null;
    }
    if (m.scorePrev !== null) {
      const prev = await latestBreakdown(sb, wsId, m.entity_id, since, true);
      if (cur && prev) {
        let best: { name: string; prev: number; next: number } | null = null;
        for (const k of SUB_SCORE_KEYS) {
          const a = num(prev[k]); const b = num(cur[k]);
          if (a == null || b == null) continue;
          if (!best || Math.abs(b - a) > Math.abs(best.next - best.prev)) best = { name: k, prev: a, next: b };
        }
        m.topSubMove = best;
      }
    }
  }

  // ---- approvals ----
  const { data: pending } = await sb.from('gates').select('id, policy, condition, requested_at').eq('workspace_id', wsId).is('decision', null).order('requested_at', { ascending: true });
  const { data: decided } = await sb.from('gates').select('id, policy, decision, decided_at, resolution').eq('workspace_id', wsId).gte('decided_at', since).lt('decided_at', until);

  // ---- domain backfill (for the "next" section) ----
  let domainBackfill: { remaining: number; perDay: number } | null = null;
  const perDay = policy.research?.domain_backfill_per_day ?? 0;
  if (perDay > 0) {
    const accountIds = await entityIdsOfType(sb, wsId, 'account');
    let noDomain = 0;
    for (let i = 0; i < accountIds.length; i += 200) {
      const { data } = await sb.from('entities').select('attributes, archived_at').in('id', accountIds.slice(i, i + 200));
      for (const e of (data ?? []) as any[]) {
        if (!e.archived_at && e.attributes?._candidate !== true && !(typeof e.attributes?.domain === 'string' && e.attributes.domain.length > 0)) noDomain++;
      }
    }
    domainBackfill = { remaining: noDomain, perDay };
  }

  // ---- advance pass: sum every run in the window ----
  const advanceEvents = events.filter((e) => e.action === 'advance_completed');
  let advance: AdvanceSummary | null = null;
  if (advanceEvents.length) {
    const a: AdvanceSummary = {
      runs: advanceEvents.length, scanned: 0, contacts_pulled: 0, contacts_created: 0,
      drafts_created: 0, decisions: {}, examples: {}, paused: [],
    };
    for (const e of advanceEvents) {
      const p = e.payload ?? {};
      a.scanned += p.scanned ?? 0;
      a.contacts_pulled += p.contacts_pulled ?? 0;
      a.contacts_created += p.contacts_created ?? 0;
      a.drafts_created += p.drafts_created ?? 0;
      for (const [k, v] of Object.entries(p.decisions ?? {})) a.decisions[k] = (a.decisions[k] ?? 0) + (v as number);
      for (const [k, names] of Object.entries(p.examples ?? {})) {
        const list = a.examples[k] ?? (a.examples[k] = []);
        for (const n of names as string[]) if (list.length < 6 && !list.includes(n)) list.push(n);
      }
      if (p.paused) a.paused.push(p.paused);
    }
    advance = a;
  }

  // ---- repeat scoring: writes that re-judged identical evidence ----
  const breakdowns = facts.filter((f) => f.predicate === 'icp_fit_breakdown');
  const bdByEntity = new Map<string, FactRow[]>();
  breakdowns.forEach((f) => { const a = bdByEntity.get(f.subject_entity) ?? []; a.push(f); bdByEntity.set(f.subject_entity, a); });
  const rescoring: Rescoring = { writes: breakdowns.length, entities: bdByEntity.size, redundant: 0, offenders: [] };
  for (const [ent, rows] of bdByEntity) {
    let redundant = 0;
    let prevHash: string | null = null;
    for (const r of rows) {
      let h: string | null = null;
      try { h = (JSON.parse(r.object_text ?? '{}') as { inputs_hash?: string }).inputs_hash ?? null; } catch { h = null; }
      if (h != null && prevHash != null && h === prevHash) redundant++;
      if (h != null) prevHash = h;
    }
    rescoring.redundant += redundant;
    if (redundant > 0) rescoring.offenders.push({ name: N(ent), writes: rows.length, redundant });
  }
  rescoring.offenders.sort((a, b) => b.redundant - a.redundant);
  rescoring.offenders = rescoring.offenders.slice(0, 10);

  // ---- health: current sweep, plus the RED set as of the window start ----
  let health: PeriodData['health'] = null;
  try {
    const checks = await sweepWorkspace(sb, wsId);
    const { data: lastAlert } = await sb.from('events')
      .select('payload').eq('workspace_id', wsId).eq('action', 'health_alert')
      .lt('created_at', since).order('created_at', { ascending: false }).limit(1);
    const prev = (lastAlert?.[0]?.payload as { red_ids?: string[] } | undefined)?.red_ids;
    health = { checks, prevRedIds: Array.isArray(prev) ? prev : null, checkedAt: new Date().toISOString() };
  } catch {
    health = null; // a broken check shouldn't take the whole digest down
  }

  return {
    workspace: { id: wsId, name: wsName },
    window, policy, pricing, pipelineStatus,
    nameOf, accountOfChannel,
    events, signals, facts, posts,
    moves, movesTruncated, prevScoreOf,
    approvals: { pending: (pending ?? []) as GateLite[], decided: (decided ?? []) as GateLite[] },
    domainBackfill,
    advance, rescoring, health,
  };
}

// Latest icp_fit_breakdown for an entity at or before a cutoff. `exclusive`
// makes it strictly before (used for the pre-window baseline).
async function latestBreakdown(sb: SupabaseClient, wsId: string, ent: string, cutoff: string, exclusive: boolean): Promise<Record<string, unknown> | null> {
  let q = sb.from('facts').select('object_text, observed_at').eq('workspace_id', wsId).eq('subject_entity', ent).eq('predicate', 'icp_fit_breakdown');
  q = exclusive ? q.lt('observed_at', cutoff) : q.lte('observed_at', cutoff);
  const { data } = await q.order('observed_at', { ascending: false }).limit(1);
  if (!data?.[0]?.object_text) return null;
  try { return JSON.parse(data[0].object_text) as Record<string, unknown>; } catch { return null; }
}

function num(v: unknown): number | null { const n = typeof v === 'number' ? v : parseFloat(String(v)); return Number.isFinite(n) ? n : null; }

// ---------- rendering (pure) ----------

const fmt = (n: number) => n.toLocaleString('en-US');
const usd = (n: number) => `$${n.toFixed(2)}`;
const ts = (s: string) => s.slice(5, 16).replace('T', ' ');
const sgn = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
const daysAgo = (iso: string, now: number) => Math.floor((now - Date.parse(iso)) / 86400e3);
/** "3 days" / "1 day" / "today" — pending approvals read as age, not timestamps. */
const age = (iso: string, now: number) => {
  const d = daysAgo(iso, now);
  return d <= 0 ? 'today' : `${d} day${d === 1 ? '' : 's'}`;
};

export function renderMarkdown(d: PeriodData): string {
  const L: string[] = [];
  const H = (t: string) => L.push('', `## ${t}`, '');
  const N = (id: string | null | undefined) => (id && d.nameOf[id]) ?? (id ?? '?').slice(0, 8);
  const events = d.events;
  const by = (action: string) => events.filter((e) => e.action === action);

  L.push(`# ${d.workspace.name}: ${d.window.label}`, `Window: ${d.window.since.slice(0, 16)}Z → ${d.window.until.slice(0, 16)}Z. Pipeline: ${d.pipelineStatus}`);

  // ---- What moved and why (the join) ----
  const research = by('research_completed');
  const searches = research.reduce((a, e) => a + (e.payload?.searches ?? 0), 0);
  H(`What moved and why: ${d.moves.length} account${d.moves.length === 1 ? '' : 's'} (of ${fmt(searches)} searches, ${fmt(d.signals.length)} signals)`);
  if (!d.moves.length) L.push('No scored accounts changed in this window.');
  for (const m of d.moves) {
    const head = m.scorePrev === null ? `NEW → ${m.scoreNew.toFixed(2)}` : `${m.scorePrev.toFixed(2)} → ${m.scoreNew.toFixed(2)} (${sgn(m.scoreDelta)})`;
    L.push(`### ${m.name}   score ${head}`);
    const why = m.topSubMove
      ? `${m.topSubMove.name} ${m.topSubMove.prev.toFixed(2)} → ${m.topSubMove.next.toFixed(2)}. ${m.reasoning ?? ''}`.trim()
      : (m.reasoning ?? (m.scorePrev === null ? 'First score this window.' : 'No breakdown recorded.'));
    L.push(`Why: ${why}`);
    if (m.signals.length) {
      L.push('New this window:');
      for (const s of m.signals.slice(0, 4)) L.push(`  - [${s.angle}, mag ${s.magnitude ?? '?'}] "${s.body}"${s.url ? ` ${s.url}` : ''}`);
      if (m.signals.length > 4) L.push(`  - …and ${m.signals.length - 4} more signal(s)`);
    } else if (m.newFacts.length) {
      L.push(`New facts: ${m.newFacts.slice(0, 3).map((f) => `${f.predicate}=${f.object}`).join('; ')}`);
    }
    L.push(m.drafted ? `Drafted: yes → "${m.drafted.body.slice(0, 400)}"` : 'Drafted: no');
    L.push('');
  }
  if (d.movesTruncated) L.push(`…and ${d.movesTruncated} more account(s) with smaller moves.`);

  // ---- first scores: the shape they share is the story, not each row ----
  const firsts = d.moves.filter((m) => m.scorePrev === null);
  if (firsts.length >= 2) {
    const lo = Math.min(...firsts.map((m) => m.scoreNew));
    const hi = Math.max(...firsts.map((m) => m.scoreNew));
    H(`First scores: ${firsts.length} accounts, ${lo.toFixed(2)} to ${hi.toFixed(2)}`);
    L.push(firsts.map((m) => `${m.name} ${m.scoreNew.toFixed(2)}`).join(', '));
    // Dimensions every one of them landed on the same value: that is what the
    // cohort is actually telling you (e.g. "industry obvious, no company size
    // ground truth, no trigger"), and it points at research vs a rubric change.
    const shared: string[] = [];
    for (const k of SUB_SCORE_KEYS) {
      const vals = firsts.map((m) => m.subScores?.[k]).filter((v): v is number => v != null);
      const first = vals[0];
      if (first != null && vals.length === firsts.length && vals.every((v) => Math.abs(v - first) < 0.005)) shared.push(`${k} ${first.toFixed(2)}`);
    }
    if (shared.length) L.push('', `All ${firsts.length} scored identically on: ${shared.join(', ')}. A shared shape like this moves with new research, not with a scoring tweak.`);
  }

  // ---- Research ----
  const sigCountByEntity = new Map<string, number>();
  d.signals.forEach((s) => { const k = N(s.entity_id); sigCountByEntity.set(k, (sigCountByEntity.get(k) ?? 0) + 1); });
  const topAccounts = [...sigCountByEntity].sort((a, b) => b[1] - a[1]).slice(0, 10);
  H(`Research: ${research.length} runs, ${searches} searches, ${fmt(d.signals.length)} signals`);
  L.push(`Top accounts: ${topAccounts.map(([k, v]) => `${k} (${v})`).join(', ') || 'none'}`);
  for (const e of by('research_error')) L.push(`ERROR ${ts(e.created_at)}: ${JSON.stringify(e.payload).slice(0, 200)}`);
  const highlights = [...d.signals].sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0)).slice(0, 5);
  if (highlights.length) L.push('', 'Signal highlights:');
  for (const s of highlights) {
    const tags = s.structured_tags ?? {};
    L.push(`- **${N(s.entity_id)}** (${tags.research_angle ?? tags.signal_source ?? 'signal'}, magnitude ${s.magnitude ?? '?'}) ${tags.url ?? ''}`);
    L.push(`  > ${(s.body_for_embedding ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
  }

  // ---- Domains ----
  const resolved = by('domain_resolved'); const domFailed = by('domain_resolve_failed');
  H(`Domains: ${resolved.length} resolved, ${domFailed.length} refused`);
  for (const e of resolved) L.push(`- ${N(e.target_id)} → ${e.payload?.domain}`);

  // ---- Scoring ----
  const scoreFacts = d.facts.filter((f) => f.predicate === 'icp_fit');
  const byEntity = new Map<string, FactRow[]>();
  scoreFacts.forEach((f) => { const a = byEntity.get(f.subject_entity) ?? []; a.push(f); byEntity.set(f.subject_entity, a); });
  H(`Scoring: ${scoreFacts.length} account score writes across ${byEntity.size} accounts`);
  const movers: Array<{ name: string; prev: string; last: string; delta: number }> = [];
  for (const [ent, rows] of byEntity) {
    const prev = d.prevScoreOf[ent];
    const last = rows[rows.length - 1]?.object_text ?? '';
    const delta = prev != null ? Math.abs(parseFloat(last) - parseFloat(prev)) : Infinity;
    movers.push({ name: N(ent), prev: prev ?? 'NEW', last, delta: isNaN(delta) ? 0 : delta });
  }
  movers.sort((a, b) => b.delta - a.delta);
  for (const m of movers.slice(0, 15)) L.push(`- ${m.name}: ${m.prev} → ${m.last}`);
  if (movers.length > 15) L.push(`- …and ${movers.length - 15} more (unchanged or small moves)`);

  // ---- repeat scoring ----
  const r = d.rescoring;
  if (r.writes) {
    const pct = r.writes ? Math.round((r.redundant / r.writes) * 100) : 0;
    L.push('', `Repeat scoring: ${r.redundant} of ${r.writes} breakdown write(s) re-judged evidence that had not changed (${pct}%).`);
    if (r.redundant === 0) L.push('Every write followed new evidence. That is the healthy state.');
    for (const o of r.offenders) L.push(`- ${o.name}: ${o.writes} writes, ${o.redundant} on unchanged evidence`);
    if (r.redundant > 0) L.push('Each repeat is one rubric call plus its embedding calls spent to arrive at a number already on file.');
  }

  // ---- Contacts ----
  const pulls = by('contacts_completed');
  const newContacts = d.facts.filter((f) => f.predicate === 'is_a' && f.object_text === 'contact');
  const contactScores = new Map(d.facts.filter((f) => f.predicate === 'contact_score').map((f) => [f.subject_entity, f.object_text]));
  const roles = new Map(d.facts.filter((f) => f.predicate === 'role').map((f) => [f.subject_entity, f.object_text]));
  H(`Contacts: ${pulls.length} pull attempts, ${newContacts.length} new contacts`);
  for (const f of newContacts) L.push(`- ${N(f.subject_entity)} (${roles.get(f.subject_entity) ?? 'role unknown'}, score ${contactScores.get(f.subject_entity) ?? '?'})`);
  const failReasons = new Map<string, number>();
  for (const e of pulls) {
    const s = e.payload?.summary ?? '';
    if (!/new contact/.test(s)) failReasons.set(s, (failReasons.get(s) ?? 0) + 1);
  }
  if (failReasons.size) L.push('', 'Pulls that produced nothing:');
  for (const [reason, count] of [...failReasons].sort((a, b) => b[1] - a[1])) L.push(`- ${count}× ${reason}`);

  // ---- Drafts & sends ----
  const drafts = d.posts.filter((p) => p.kind === 'touch_draft');
  const sends = d.posts.filter((p) => p.kind === 'system' && /^Sent →/.test(p.body ?? ''));
  const draftFlags = d.posts.filter((p) => p.kind === 'system' && /^Draft checks:/.test(p.body ?? ''));
  H(`Drafts: ${drafts.length} written, ${sends.length} sent`);
  for (const p of drafts) {
    L.push(`**${N(d.accountOfChannel[p.channel_id])}** (${ts(p.created_at)})`);
    L.push(`> ${(p.body ?? '').replace(/\n/g, ' ')}`, '');
  }
  for (const p of sends) L.push(`- SENT ${ts(p.created_at)} ${N(d.accountOfChannel[p.channel_id])}: ${p.body}`);
  for (const p of draftFlags) L.push(`- FLAG ${N(d.accountOfChannel[p.channel_id])}: ${(p.body ?? '').replace('Draft checks: ', '')}`);

  // ---- Everything else the advance pass looked at ----
  if (d.advance) {
    const a = d.advance;
    H(`Advance pass: ${fmt(a.scanned)} accounts scanned across ${a.runs} run(s)`);
    const rows = Object.entries(a.decisions).sort((x, y) => y[1] - x[1]);
    for (const [reason, count] of rows) {
      const ex = a.examples[reason] ?? [];
      const named = ex.length && count <= 8 ? `   ${ex.join(', ')}` : '';
      L.push(`- ${reason}: ${count}${named}`);
    }
    L.push(`Contacts: ${a.contacts_pulled} pull attempt(s), ${a.contacts_created} created. Drafts: ${a.drafts_created}.`);
    for (const p of a.paused) L.push(`- PAUSED mid-run: ${p}`);
  }

  // ---- Approvals ----
  const nowMs = Date.parse(d.window.until);
  H(`Approvals: ${d.approvals.pending.length} waiting, ${d.approvals.decided.length} decided in window`);
  for (const g of d.approvals.pending) L.push(`- WAITING ${age(g.requested_at ?? '', nowMs)} (since ${ts(g.requested_at ?? '')}) [${g.policy}] ${(g.condition?.body ?? '').replace(/\n/g, ' ').slice(0, 140)}`);
  for (const g of d.approvals.decided) L.push(`- ${g.decision?.toUpperCase()} ${ts(g.decided_at ?? '')} [${g.policy}]${g.resolution?.edited ? ' (edited before send)' : ''}`);

  // ---- Facts ----
  const scoringPreds = /^(icp_fit|score_|contact_score)/;
  const identityPreds = new Set(['is_a', 'email', 'works_at', 'role']);
  const researchFacts = d.facts.filter((f) => !scoringPreds.test(f.predicate) && !identityPreds.has(f.predicate));
  H(`Facts: ${fmt(d.facts.length)} total (${researchFacts.length} from research, rest scoring + contact identity)`);
  const pains = researchFacts.filter((f) => f.predicate === 'pain_observed');
  for (const f of pains) L.push(`- PAIN ${N(f.subject_entity)}: ${(f.object_text ?? '').slice(0, 200)}`);
  for (const f of researchFacts.filter((x) => x.predicate !== 'pain_observed').slice(0, 12))
    L.push(`- ${N(f.subject_entity)} ${f.predicate} = ${(f.object_text ?? '').slice(0, 100)}`);
  if (researchFacts.length > 12 + pains.length) L.push(`- …and ${researchFacts.length - 12 - pains.length} more`);

  // ---- Health ----
  // The sweep runs against the DB as it is right now, not as of the window end,
  // so a backdated report shows today's status next to that window's activity.
  // Said plainly rather than hidden.
  if (d.health) {
    const reds = d.health.checks.filter((c) => c.severity === 'red');
    const yellows = d.health.checks.filter((c) => c.severity === 'yellow');
    const prev = d.health.prevRedIds;
    const delta = prev ? ` (was RED=${prev.length} at window start)` : '';
    H(`Health now: RED=${reds.length} YELLOW=${yellows.length}${delta}`);
    if (prev) {
      const cleared = prev.filter((id) => !reds.some((c) => c.id === id));
      const added = reds.filter((c) => !prev.includes(c.id)).map((c) => c.id);
      if (cleared.length) L.push(`Cleared: ${cleared.join(', ')}`);
      if (added.length) L.push(`New: ${added.join(', ')}`);
    }
    for (const c of [...reds, ...yellows]) L.push(`- ${c.severity.toUpperCase()} ${c.id}: ${c.metric}${c.threshold ? ` (threshold ${c.threshold})` : ''}`);
    if (!reds.length && !yellows.length) L.push('All checks green.');
    if (Date.parse(d.health.checkedAt) - Date.parse(d.window.until) > 3600e3) L.push('', 'Note: checks reflect the database right now, not the end of the reported window.');
  }
  const healthEvents = events.filter((e) => /health_alert|pause/i.test(e.action));
  if (healthEvents.length) {
    L.push('', 'Health events in window:');
    for (const e of healthEvents) L.push(`- ${ts(e.created_at)} ${e.action}: ${JSON.stringify(e.payload).slice(0, 160)}`);
  }

  // ---- Spend estimate ----
  H('Spend estimate');
  const metrics = by('agent_run_metrics');
  const byModel = new Map<string, { input: number; cached: number; output: number; runs: number }>();
  for (const e of metrics) {
    const model = String(e.payload?.model ?? 'unknown').split('/').pop()!;
    const m = byModel.get(model) ?? { input: 0, cached: 0, output: 0, runs: 0 };
    m.input += e.payload?.input_tokens ?? 0;
    m.cached += e.payload?.cached_input_tokens ?? 0;
    m.output += e.payload?.output_tokens ?? 0;
    m.runs += 1;
    byModel.set(model, m);
  }
  const behaviors = [...new Set(metrics.map((e) => String(e.payload?.behavior ?? '?')))];
  L.push(`Token metrics cover: ${behaviors.join(', ') || 'none'}. Behaviors without metrics (e.g. scorer, research planner) are NOT counted, so LLM spend is a floor.`);
  let llmTotal = 0;
  for (const [model, m] of byModel) {
    const rate = d.pricing.models[model];
    const cost = rate ? ((m.input - m.cached) / 1e6) * rate.input + (m.cached / 1e6) * rate.cached + (m.output / 1e6) * rate.output : NaN;
    if (!isNaN(cost)) llmTotal += cost;
    L.push(`- ${model}: ${m.runs} runs, ${fmt(m.input)} in (${fmt(m.cached)} cached) / ${fmt(m.output)} out → ${isNaN(cost) ? 'NO RATE CONFIGURED' : usd(cost)}`);
  }
  const standaloneDomainSearches = Math.max(0, resolved.length + domFailed.length - research.filter((e) => e.payload?.domain_resolved || /domain/.test(e.payload?.summary ?? '')).length);
  const exaSearches = searches + standaloneDomainSearches;
  const exaPages = exaSearches * d.pricing.exa_avg_pages_per_search;
  const exaCost = exaSearches * d.pricing.exa_per_search + exaPages * d.pricing.exa_per_content_page;
  const hunterSearches = pulls.filter((e) => /hunter/.test(e.payload?.summary ?? '')).length;
  const hunterCost = hunterSearches * d.pricing.hunter_per_search;
  L.push(`- Exa: ~${exaSearches} searches + ~${exaPages} content pages → ${usd(exaCost)}`);
  L.push(`- Hunter: ${hunterSearches} credits used${hunterCost ? ` → ${usd(hunterCost)}` : ' (credit-limited plan, no overage: hard stop when credits run out)'}`);
  const total = llmTotal + exaCost + hunterCost;
  const perDay = d.window.hours > 0 ? (total * 24) / d.window.hours : total;
  L.push(`- **Total: ~${usd(total)} over ${d.window.label} (~${usd(perDay)}/day at this pace)** (rates: provider list prices, override in policy.report.pricing)`);

  // ---- What's next ----
  H('What\'s next');
  if (d.approvals.pending.length) {
    const oldest = d.approvals.pending[0]?.requested_at;
    L.push(`- ${d.approvals.pending.length} draft(s) waiting for your approval${oldest ? `, oldest sitting ${age(oldest, nowMs)}` : ''}.`);
  }
  if (d.rescoring.redundant > 0) L.push(`- ${d.rescoring.redundant} score write(s) re-judged unchanged evidence. That is spend with no new answer behind it.`);
  const lastResearch = research[research.length - 1];
  if (lastResearch) L.push(`- Research keeps cycling (${research.length} runs in the window, last ${ts(lastResearch.created_at)}).`);
  if (d.domainBackfill) L.push(`- Domain backfill: ${fmt(d.domainBackfill.remaining)} accounts still missing a domain, draining ${d.domainBackfill.perDay}/day (~${Math.ceil(d.domainBackfill.remaining / d.domainBackfill.perDay)} days).`);
  const keyErrors = [...failReasons.keys()].filter((r) => /not set|API key/i.test(r));
  for (const r of keyErrors) L.push(`- BLOCKER: "${r}". Fix the key or contact pulls stay on the fallback provider.`);
  const noDomainPulls = failReasons.get('no domain on account');
  if (noDomainPulls) L.push(`- ${noDomainPulls} account(s) skipped contact pull for lack of a domain; backfill unblocks them.`);
  return L.join('\n');
}

// ---------- markdown -> email HTML (minimal, covers what renderMarkdown emits) ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s: string) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

/**
 * Render the digest markdown as simple inline-styled HTML for email clients.
 * Handles exactly the constructs renderMarkdown produces: #/##/### headers,
 * `- ` bullets (one nesting level), `> ` quotes, **bold**, plain paragraphs.
 * Not a general markdown parser and doesn't try to be.
 */
export function mdToHtml(md: string): string {
  const out: string[] = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const m = /^(#{1,3}) (.*)$/.exec(line);
    if (m) {
      closeList();
      // Both groups are guaranteed by the regex that just matched; the locals
      // are what make that provable under noUncheckedIndexedAccess.
      const level = (m[1] ?? '').length;
      const size = level === 1 ? 20 : level === 2 ? 16 : 14;
      out.push(`<h${level} style="font-size:${size}px;margin:${level === 1 ? 16 : 20}px 0 6px">${inline(m[2] ?? '')}</h${level}>`);
      continue;
    }
    if (/^\s*- /.test(line)) {
      if (!inList) { out.push('<ul style="margin:4px 0;padding-left:20px">'); inList = true; }
      out.push(`<li style="margin:2px 0">${inline(line.replace(/^\s*- /, ''))}</li>`);
      continue;
    }
    closeList();
    if (line.startsWith('> ')) { out.push(`<blockquote style="margin:4px 0 8px;padding-left:10px;border-left:3px solid #ccc;color:#444">${inline(line.slice(2))}</blockquote>`); continue; }
    if (line === '') { out.push(''); continue; }
    out.push(`<p style="margin:4px 0">${inline(line)}</p>`);
  }
  closeList();
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.45;color:#111;max-width:720px">${out.join('\n')}</div>`;
}
