/**
 * "Today" — the agent's own briefing for the workspace home.
 *
 * Tells the same story as the daily digest email (what the agent did + the
 * accounts that moved and why), but computed with a lean, fully-batched query
 * path instead of the digest's collectPeriod. collectPeriod does a whole
 * domain-backfill scan and sequential per-account breakdown reads (~11s on this
 * workspace) — fine for a once-a-day email, far too slow for a page load. Here
 * every read is windowed and batched (no N+1), then cached 120s so warm hits
 * are instant and share the feed's cache invalidation on gate decisions.
 */
import { unstable_cache } from 'next/cache';
import { createServerClient } from '@agent-crm/db';
import { fetchAll } from '@agent-crm/tools';

export interface TodayMove {
  entity_id: string;
  name: string;
  scorePrev: number | null; // null = first score in the window
  scoreNew: number;
  why: string; // the scorer's plain words, or the freshest signal, in one line
}

export interface TodayData {
  windowLabel: string;
  runs: number; // research runs completed
  researched: number; // distinct accounts touched by research
  signals: number;
  scored: number; // distinct accounts (re)scored
  draftsWritten: number;
  moved: TodayMove[];
  pipelineStatus: string; // 'running' or 'paused (reason)'
}

const WINDOW_HOURS = 24;
const MOVED_CAP = 6;

// The scorer sometimes prefixes a sentence with a machine field label
// ("industry_match:", "Industry:"). That's a single token + colon (shape, not
// any vertical-specific value), so strip it so the line reads as prose.
function stripFieldLabel(s: string): string {
  return s.replace(/^[A-Za-z]+(?:_[A-Za-z]+)*:\s+/, '');
}

// One-to-two clean sentences from the scorer's reasoning, cut on a sentence
// boundary so we never truncate mid-word. Keeps the briefing readable.
function firstSentences(s: string, max: number): string {
  const t = stripFieldLabel(s.trim().replace(/\s+/g, ' '));
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  const lastStop = slice.lastIndexOf('. ');
  if (lastStop > 60) return slice.slice(0, lastStop + 1);
  return slice.trimEnd() + '…';
}

interface SignalRow { entity_id: string | null; magnitude: number | null; body_for_embedding: string | null; created_at: string }
interface FactRow { subject_entity: string; object_text: string | null; observed_at: string }

const _getTodayData = async (ws: string): Promise<TodayData> => {
  const sb = createServerClient();
  const until = new Date().toISOString();
  const since = new Date(Date.now() - WINDOW_HOURS * 3600e3).toISOString();
  const windowLabel = `last ${WINDOW_HOURS}h`;

  // Round 1 — everything independent, in parallel.
  const [wsRow, runsRes, draftsRes, pendingRes, signals, winFacts] = await Promise.all([
    sb.from('workspaces').select('policy').eq('id', ws).maybeSingle(),
    sb.from('events').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('action', 'research_completed').gte('created_at', since).lt('created_at', until),
    sb.from('channel_posts').select('id, channels!inner(workspace_id)', { count: 'exact', head: true }).eq('channels.workspace_id', ws).eq('kind', 'touch_draft').gte('created_at', since).lt('created_at', until),
    sb.from('gates').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).is('decision', null),
    fetchAll<SignalRow>((f, t) => sb.from('signals').select('entity_id, magnitude, body_for_embedding, created_at').eq('workspace_id', ws).gte('created_at', since).lt('created_at', until).range(f, t)),
    fetchAll<FactRow>((f, t) => sb.from('facts').select('subject_entity, object_text, observed_at').eq('workspace_id', ws).eq('predicate', 'icp_fit').gte('observed_at', since).lt('observed_at', until).order('observed_at', { ascending: true }).range(f, t)),
  ]);

  const policy = (wsRow.data?.policy ?? {}) as { pipeline?: { status?: string; reason?: string } };
  const pipelineStatus = policy.pipeline?.status ? `${policy.pipeline.status} (${policy.pipeline.reason ?? ''})` : 'running';

  const researched = new Set(signals.map((s) => s.entity_id).filter(Boolean)).size;

  // Latest score in the window per account (facts sorted ascending → last wins).
  const newScoreOf = new Map<string, number>();
  for (const f of winFacts) {
    const v = parseFloat(f.object_text ?? '');
    if (Number.isFinite(v)) newScoreOf.set(f.subject_entity, v);
  }
  const scoredIds = [...newScoreOf.keys()];

  // Freshest signal body per account, for the "why" fallback when the scorer
  // left no reasoning.
  const topSignalOf = new Map<string, string>();
  for (const s of signals) {
    if (!s.entity_id || topSignalOf.has(s.entity_id)) continue;
    const b = (s.body_for_embedding ?? '').replace(/\s+/g, ' ').trim();
    if (b) topSignalOf.set(s.entity_id, b);
  }

  // Round 2 — prior scores + reasoning + names for the scored accounts, batched.
  const [prevFacts, breakdownFacts, nameRows] = await Promise.all([
    scoredIds.length
      ? fetchAll<FactRow>((f, t) => sb.from('facts').select('subject_entity, object_text, observed_at').eq('workspace_id', ws).eq('predicate', 'icp_fit').in('subject_entity', scoredIds).lt('observed_at', since).order('observed_at', { ascending: false }).range(f, t))
      : Promise.resolve([] as FactRow[]),
    scoredIds.length
      ? fetchAll<FactRow>((f, t) => sb.from('facts').select('subject_entity, object_text, observed_at').eq('workspace_id', ws).eq('predicate', 'icp_fit_breakdown').in('subject_entity', scoredIds).order('observed_at', { ascending: false }).range(f, t))
      : Promise.resolve([] as FactRow[]),
    scoredIds.length
      ? sb.from('entities').select('id, name').in('id', scoredIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
  ]);

  const prevScoreOf = new Map<string, number>();
  for (const f of prevFacts) { // desc order → first seen per entity is the latest-before-window
    if (prevScoreOf.has(f.subject_entity)) continue;
    const v = parseFloat(f.object_text ?? '');
    if (Number.isFinite(v)) prevScoreOf.set(f.subject_entity, v);
  }
  const reasoningOf = new Map<string, string>();
  for (const f of breakdownFacts) {
    if (reasoningOf.has(f.subject_entity) || !f.object_text) continue;
    try {
      const j = JSON.parse(f.object_text) as { reasoning?: unknown };
      if (typeof j.reasoning === 'string' && j.reasoning.trim()) reasoningOf.set(f.subject_entity, j.reasoning.trim());
    } catch { /* skip unparseable */ }
  }
  const nameOf = new Map<string, string>();
  for (const r of (nameRows.data ?? []) as Array<{ id: string; name: string }>) nameOf.set(r.id, r.name);

  // Build moves: keep real movement, fresh signal, or a first score. Drop idle
  // rescores (score barely changed, no new signal, and had a prior score).
  const candidates = scoredIds.map((id) => {
    const scoreNew = newScoreOf.get(id)!;
    const scorePrev = prevScoreOf.has(id) ? prevScoreOf.get(id)! : null;
    const delta = scoreNew - (scorePrev ?? 0);
    return { id, scoreNew, scorePrev, delta, hasSignal: topSignalOf.has(id) };
  }).filter((c) => !(Math.abs(c.delta) < 0.01 && !c.hasSignal && c.scorePrev !== null));

  candidates.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const moved: TodayMove[] = candidates.slice(0, MOVED_CAP).map((c) => {
    const reasoning = reasoningOf.get(c.id);
    const why = reasoning
      ? firstSentences(reasoning, 170)
      : topSignalOf.has(c.id)
        ? firstSentences(topSignalOf.get(c.id)!, 170)
        : c.scorePrev === null ? 'First look at this account.' : 'Rescored on fresh research.';
    return { entity_id: c.id, name: nameOf.get(c.id) ?? c.id.slice(0, 8), scorePrev: c.scorePrev, scoreNew: c.scoreNew, why };
  });

  return {
    windowLabel,
    runs: runsRes.count ?? 0,
    researched,
    signals: signals.length,
    scored: scoredIds.length,
    draftsWritten: draftsRes.count ?? 0,
    moved,
    pipelineStatus,
  };
};

export const getTodayData = unstable_cache(_getTodayData, ['today-data'], {
  revalidate: 120,
  tags: ['feed', 'today'],
});
