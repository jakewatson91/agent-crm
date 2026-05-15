import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';

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
  confidence: number;
  observed_at: string;
}

const RECENT_WINDOW_DAYS = 14;

// Fact predicate families. Groups noisy per-dimension scoring facts together
// and surfaces business attributes (industry, stage, etc.) as the lead.
const FACT_FAMILIES: Array<{ name: string; match: (p: string) => boolean }> = [
  { name: 'firmographics', match: (p) => ['industry', 'stage', 'yc_status', 'yc_batch', 'is_hiring', 'team_size', 'location', 'domain'].includes(p) },
  { name: 'scoring',       match: (p) => p.startsWith('score_') || p === 'icp_fit' || p === 'icp_fit_breakdown' },
  { name: 'engagement',    match: (p) => ['dropped_until', 'research_triggered', 'contact_lookup_attempted', 'works_at', 'email', 'role'].includes(p) },
];
function familyOf(predicate: string): string {
  for (const f of FACT_FAMILIES) if (f.match(predicate)) return f.name;
  return 'other';
}

function dedupKey(it: GroupedItem): string {
  return `${it.kind}::${[...it.cites].sort().join(',')}`;
}

export async function GET(_req: Request, { params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  const supabase = createServerClient();

  const ch = await supabase.from('channels').select('id, title, account_entity_id, workspace_id').eq('id', channel).maybeSingle();
  if (ch.error || !ch.data) return NextResponse.json({ error: 'channel not found' }, { status: 404 });
  const account_id = ch.data.account_entity_id as string;

  const ent = await supabase.from('entities').select('name, attributes, kind').eq('id', account_id).maybeSingle();

  const now = Date.now();
  const recentSince = new Date(now - RECENT_WINDOW_DAYS * 86400 * 1000).toISOString();

  const [factsRes, postsRes] = await Promise.all([
    supabase.from('facts').select('id, predicate, object_text, confidence, observed_at, supersedes')
      .eq('subject_entity', account_id).order('observed_at', { ascending: false }).limit(200),
    supabase.from('channel_posts').select('id, kind, body, cites, author_id, parent_post_id, created_at')
      .eq('channel_id', channel).order('created_at', { ascending: false }).limit(400),
  ]);

  // ---- Active facts grouped by family ----
  const factRows = (factsRes.data ?? []) as Array<{ id: string; predicate: string; object_text: string | null; confidence: number; observed_at: string; supersedes: string | null }>;
  const supersededIds = new Set(factRows.map((f) => f.supersedes).filter((x): x is string => !!x));
  const activeFacts: Record<string, Fact[]> = {};
  for (const f of factRows) {
    if (supersededIds.has(f.id)) continue;
    const fam = familyOf(f.predicate);
    (activeFacts[fam] ??= []).push({
      id: f.id, predicate: f.predicate, object_text: f.object_text,
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
    entity: ent.data,
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
