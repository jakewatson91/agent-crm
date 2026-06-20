import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { getEntityTypes, getPolicy, factFamilyOf } from '@agent-crm/tools';
import { resolveEntityNames } from '../../../_lib/resolve_entity_names';

export const runtime = 'nodejs';

/**
 * Summary projection for a channel — three sections:
 *   - recent_activity: last 14d, parent-collapsed and deduped (the actually-useful view)
 *   - current_facts:   active (non-superseded) facts grouped by predicate family
 *   - history:         older posts collapsed by week + kind
 *
 * This is the user-facing read. The raw chronological audit lives at /timeline
 * for the time-travel slider — kept untouched. Agents can hit /summary for a
 * token-efficient digest without pulling the full timeline.
 */

interface GroupedItem {
  id: string;
  ts: string;
  kind: 'claim' | 'decision' | 'touch_draft' | 'gate_request' | 'outcome' | 'system' | 'question';
  body: string;
  reasoning: string | null;
  cites: string[];
  author_id: string;
  dup_count: number;
}

interface Fact {
  id: string;
  predicate: string;
  object_text: string | null;
  object_entity: string | null;
  object_entity_name: string | null;
  confidence: number;
  observed_at: string;
}

const RECENT_WINDOW_DAYS = 14;

function dedupKey(it: GroupedItem): string {
  return `${it.kind}::${[...it.cites].sort().join(',')}`;
}

export async function GET(_req: Request, { params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  const supabase = createServerClient();

  const ch = await supabase.from('channels').select('id, title, account_entity_id, workspace_id').eq('id', channel).maybeSingle();
  if (ch.error || !ch.data) return NextResponse.json({ error: 'channel not found' }, { status: 404 });
  const account_id = ch.data.account_entity_id as string;

  const policy = await getPolicy(supabase, ch.data.workspace_id as string);
  const factGroups = policy.display?.fact_groups ?? [];

  const ent = await supabase.from('entities').select('name, attributes').eq('id', account_id).maybeSingle();
  const entKinds = await getEntityTypes(supabase, account_id);
  const entityWithKind = ent.data ? { ...ent.data, kind: entKinds[0] ?? 'entity', types: entKinds } : null;

  const now = Date.now();
  const recentSince = new Date(now - RECENT_WINDOW_DAYS * 86400 * 1000).toISOString();

  const [factsRes, postsRes] = await Promise.all([
    supabase.from('facts').select('id, predicate, object_text, object_entity, confidence, observed_at, supersedes')
      .eq('subject_entity', account_id).order('observed_at', { ascending: false }).limit(200),
    supabase.from('channel_posts').select('id, kind, body, cites, author_id, parent_post_id, created_at')
      .eq('channel_id', channel).order('created_at', { ascending: false }).limit(400),
  ]);

  // ---- Active facts grouped by family ----
  const factRows = (factsRes.data ?? []) as Array<{ id: string; predicate: string; object_text: string | null; object_entity: string | null; confidence: number; observed_at: string; supersedes: string | null }>;
  const supersededIds = new Set(factRows.map((f) => f.supersedes).filter((x): x is string => !!x));
  const activeRows = factRows.filter((f) => !supersededIds.has(f.id));
  // Resolve names for entity-valued facts so the UI links instead of showing a UUID.
  const nameByEntityId = await resolveEntityNames(supabase, activeRows.map((f) => f.object_entity).filter((x): x is string => !!x));
  const activeFacts: Record<string, Fact[]> = {};
  for (const f of activeRows) {
    const fam = factFamilyOf(f.predicate, factGroups);
    (activeFacts[fam] ??= []).push({
      id: f.id, predicate: f.predicate, object_text: f.object_text,
      object_entity: f.object_entity,
      object_entity_name: f.object_entity ? (nameByEntityId.get(f.object_entity) ?? null) : null,
      confidence: f.confidence, observed_at: f.observed_at,
    });
  }

  // ---- Parent-collapse posts ----
  const postRows = (postsRes.data ?? []) as Array<{ id: string; kind: string; body: string; cites: string[] | null; author_id: string; parent_post_id: string | null; created_at: string }>;
  const childByParent = new Map<string, string>();
  const childIds = new Set<string>();
  for (const p of postRows) {
    if (p.parent_post_id && p.kind === 'decision') {
      childByParent.set(p.parent_post_id, p.body);
      childIds.add(p.id);
    }
  }
  const toItem = (p: typeof postRows[number]): GroupedItem => ({
    id: p.id,
    ts: p.created_at,
    kind: p.kind as GroupedItem['kind'],
    body: p.body,
    reasoning: childByParent.get(p.id) ?? null,
    cites: Array.isArray(p.cites) ? p.cites : [],
    author_id: p.author_id,
    dup_count: 1,
  });

  // ---- Recent activity: dedup within window ----
  const recentRaw = postRows.filter((p) => !childIds.has(p.id) && p.created_at >= recentSince).map(toItem);
  // Drop empty-cite claims (legacy noise; new code never writes these).
  const recentFiltered = recentRaw.filter((it) => !(it.kind === 'claim' && it.cites.length === 0));
  const recentByKey = new Map<string, GroupedItem>();
  for (const it of recentFiltered) {
    const k = dedupKey(it);
    const prev = recentByKey.get(k);
    if (!prev) recentByKey.set(k, it);
    else prev.dup_count += 1;
  }
  const recent_activity = [...recentByKey.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

  // ---- History: older posts collapsed by (week, kind) ----
  const olderRaw = postRows.filter((p) => !childIds.has(p.id) && p.created_at < recentSince).map(toItem);
  const weekKey = (ts: string) => {
    const d = new Date(ts);
    const onejan = new Date(d.getFullYear(), 0, 1);
    const week = Math.floor((d.getTime() - onejan.getTime()) / (7 * 86400_000));
    return `${d.getFullYear()}-W${week}`;
  };
  const historyByKey = new Map<string, GroupedItem>();
  for (const it of olderRaw) {
    const k = `${weekKey(it.ts)}::${it.kind}`;
    const prev = historyByKey.get(k);
    if (!prev) historyByKey.set(k, it);
    else prev.dup_count += 1;
  }
  const history = [...historyByKey.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

  return NextResponse.json({
    channel: ch.data,
    entity: entityWithKind,
    recent_activity,
    current_facts: activeFacts,
    history,
    counts: {
      facts_active: Object.values(activeFacts).reduce((n, arr) => n + arr.length, 0),
      posts_total: postRows.length,
      recent: recent_activity.length,
      history: history.length,
    },
  });
}
