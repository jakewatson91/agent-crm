/**
 * Graph density check for the relationship-edge feature. Snapshots the metrics
 * each run and prints the delta since the last run, so re-running it shows the
 * graph filling in as the live enricher writes edges.
 *
 *   pnpm exec tsx scripts/density_check.ts
 *
 * Appends one JSON snapshot per run to .claude/density_log.jsonl.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';

const LOG = '.claude/density_log.jsonl';

type Snap = {
  ts: string; entities: number; candidates: number; total_facts: number;
  edges: number; works_at: number; new_edges: number;
  in_graph: number; components: number; largest: number; diameter: number;
  edge_types: Record<string, number>;
};

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;

  // all facts (paginated)
  type F = { id: string; predicate: string; object_entity: string | null; subject_entity: string; supersedes: string | null };
  const facts: F[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await sb.from('facts').select('id, predicate, object_entity, subject_entity, supersedes').eq('workspace_id', ws).range(from, from + 999);
    const rows = (r.data ?? []) as F[];
    facts.push(...rows);
    if (rows.length < 1000) break;
  }
  const supersededIds = new Set(facts.map((f) => f.supersedes).filter((x): x is string => !!x));
  const active = facts.filter((f) => !supersededIds.has(f.id));
  const edges = active.filter((f) => f.object_entity);

  const edge_types: Record<string, number> = {};
  for (const e of edges) edge_types[e.predicate] = (edge_types[e.predicate] ?? 0) + 1;

  // undirected adjacency over active edges
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a)!.add(b); };
  for (const e of edges) { if (e.object_entity) { add(e.subject_entity, e.object_entity); add(e.object_entity, e.subject_entity); } }
  const seen = new Set<string>(); const comps: number[] = [];
  for (const s of adj.keys()) {
    if (seen.has(s)) continue;
    let n = 0; const st = [s];
    while (st.length) { const x = st.pop()!; if (seen.has(x)) continue; seen.add(x); n++; for (const y of adj.get(x) ?? []) if (!seen.has(y)) st.push(y); }
    comps.push(n);
  }
  let diameter = 0;
  for (const start of adj.keys()) {
    const dist = new Map([[start, 0]]); const q = [start];
    while (q.length) { const x = q.shift()!; for (const y of adj.get(x) ?? []) if (!dist.has(y)) { dist.set(y, dist.get(x)! + 1); q.push(y); } }
    diameter = Math.max(diameter, ...dist.values());
  }

  const entities = (await sb.from('entities').select('id', { count: 'exact', head: true }).eq('workspace_id', ws)).count ?? 0;
  const candidates = (await sb.from('entities').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('attributes->>candidate', 'true')).count ?? 0;
  const works_at = edge_types['works_at'] ?? 0;

  const snap: Snap = {
    ts: new Date().toISOString(), entities, candidates, total_facts: facts.length,
    edges: edges.length, works_at, new_edges: edges.length - works_at,
    in_graph: adj.size, components: comps.length, largest: Math.max(0, ...comps), diameter, edge_types,
  };

  const prev: Snap | null = existsSync(LOG)
    ? (readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Snap).at(-1) ?? null)
    : null;
  const d = (cur: number, was: number | undefined) => was === undefined ? '' : `  (${cur - was >= 0 ? '+' : ''}${cur - was})`;

  console.log(`density · af602fa1 · ${snap.ts}${prev ? `   (since ${prev.ts})` : '   (baseline)'}`);
  console.log(`  edges:        ${snap.edges}${d(snap.edges, prev?.edges)}   of which non-works_at (new): ${snap.new_edges}${d(snap.new_edges, prev?.new_edges)}`);
  console.log(`  entities in graph: ${snap.in_graph}${d(snap.in_graph, prev?.in_graph)} / ${entities}   candidates: ${candidates}${d(candidates, prev?.candidates)}`);
  console.log(`  components: ${snap.components}  largest: ${snap.largest}  diameter: ${snap.diameter}${d(snap.diameter, prev?.diameter)}`);
  console.log(`  edge types: ${Object.entries(snap.edge_types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ') || '(none)'}`);
  if (prev) {
    const newTypes = Object.keys(snap.edge_types).filter((t) => !(t in prev.edge_types));
    if (newTypes.length) console.log(`  NEW edge types since last run: ${newTypes.join(', ')}`);
  }

  appendFileSync(LOG, JSON.stringify(snap) + '\n');
  console.log(`\nsnapshot appended to ${LOG}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
