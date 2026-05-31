import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const EDGE_PREDICATES = ['customer_of', 'partners_with', 'backed_by', 'integrates_with', 'invested_by', 'works_at'];

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  // 1. Find workspace with the most facts
  const wsList = await sb.from('workspaces').select('id, name');
  let best: { id: string; name: string; facts: number } | null = null;
  for (const w of wsList.data ?? []) {
    const c = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', w.id);
    const n = c.count ?? 0;
    if (!best || n > best.facts) best = { id: w.id, name: w.name as string, facts: n };
  }
  if (!best) { console.log('no workspaces'); return; }
  const ws = best.id;
  console.log(`Workspace: ${best.name} (${ws.slice(0, 8)}) — ${best.facts} facts\n`);

  // pull all facts (paginate)
  type F = { id: string; subject_entity: string; predicate: string; object_entity: string | null; object_text: string | null; supersedes: string | null };
  const facts: F[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await sb.from('facts').select('id, subject_entity, predicate, object_entity, object_text, supersedes').eq('workspace_id', ws).range(from, from + 999);
    const rows = (r.data ?? []) as F[];
    facts.push(...rows);
    if (rows.length < 1000) break;
  }
  const entCount = (await sb.from('entities').select('id', { count: 'exact', head: true }).eq('workspace_id', ws)).count ?? 0;

  // 2. Edge vs scalar
  const edges = facts.filter((f) => f.object_entity);
  const activeEdges = edges.filter((f) => !f.supersedes); // note: supersedes!=null means this fact REPLACES an older one (it is the newer version)
  console.log(`Entities: ${entCount}`);
  console.log(`Facts total: ${facts.length}  |  edge-facts (object_entity set): ${edges.length} (${(100 * edges.length / facts.length).toFixed(0)}%)  |  scalar-facts: ${facts.length - edges.length}`);

  // 3. Edge predicate distribution (only relational edge predicates)
  const byPred: Record<string, number> = {};
  for (const e of edges) byPred[e.predicate] = (byPred[e.predicate] ?? 0) + 1;
  console.log(`\nEdge predicate distribution:`);
  for (const [p, n] of Object.entries(byPred).sort((a, b) => b[1] - a[1])) {
    const isGraphEdge = EDGE_PREDICATES.includes(p) ? '' : '   (not in EDGE_PREDICATES)';
    console.log(`  ${p.padEnd(18)} ${n}${isGraphEdge}`);
  }

  // 4. Build undirected adjacency over edge facts (active only), restricted to graph EDGE_PREDICATES (what graphProximity uses)
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a)!.add(b); };
  for (const e of edges) {
    if (e.supersedes) continue;
    if (!EDGE_PREDICATES.includes(e.predicate)) continue;
    if (!e.object_entity) continue;
    add(e.subject_entity, e.object_entity);
    add(e.object_entity, e.subject_entity);
  }
  const nodesWithEdges = adj.size;
  const degrees = [...adj.values()].map((s) => s.size).sort((a, b) => b - a);
  const avgDeg = degrees.length ? (degrees.reduce((a, b) => a + b, 0) / degrees.length) : 0;
  console.log(`\nGraph (EDGE_PREDICATES only, active edges, undirected):`);
  console.log(`  entities with >=1 edge: ${nodesWithEdges} / ${entCount} (${(100 * nodesWithEdges / Math.max(1, entCount)).toFixed(0)}% of entities are in the graph at all)`);
  console.log(`  degree: max=${degrees[0] ?? 0} avg=${avgDeg.toFixed(2)} median=${degrees[Math.floor(degrees.length / 2)] ?? 0}`);
  console.log(`  degree histogram (deg:count): ${histogram(degrees)}`);

  // 5. Connected components + size distribution
  const seen = new Set<string>();
  const comps: number[] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    let size = 0; const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n); size++;
      for (const nb of adj.get(n) ?? []) if (!seen.has(nb)) stack.push(nb);
    }
    comps.push(size);
  }
  comps.sort((a, b) => b - a);
  console.log(`  connected components: ${comps.length}  | sizes (top 10): ${comps.slice(0, 10).join(', ')}`);

  // 6. Does ANY chain of length >=2 exist? (a node whose neighbor has a neighbor other than itself)
  //    And measure max BFS depth (eccentricity) from the highest-degree node = how deep chains actually go.
  let twoHopPairs = 0;
  for (const [a, nbrs] of adj) {
    for (const b of nbrs) {
      for (const c of adj.get(b) ?? []) if (c !== a) twoHopPairs++;
    }
  }
  const maxDepth = comps.length ? bfsMaxDepth(adj) : 0;
  console.log(`  2-hop paths (A-B-C, C!=A) exist: ${twoHopPairs > 0 ? 'YES' : 'NO'} (count ${twoHopPairs / 2})`);
  console.log(`  longest shortest-path (graph diameter, max over components): ${maxDepth} hops`);

  // 7. Supersede chains (temporal versioning of the same claim)
  const byId = new Map(facts.map((f) => [f.id, f]));
  const depthMemo = new Map<string, number>();
  const depthOf = (id: string): number => {
    if (depthMemo.has(id)) return depthMemo.get(id)!;
    const f = byId.get(id);
    if (!f || !f.supersedes || !byId.has(f.supersedes)) { depthMemo.set(id, 1); return 1; }
    const d = 1 + depthOf(f.supersedes);
    depthMemo.set(id, d); return d;
  };
  const supersededCount = facts.filter((f) => f.supersedes).length;
  const chainDepths = facts.map((f) => depthOf(f.id));
  const maxChain = Math.max(0, ...chainDepths);
  const chainHist: Record<number, number> = {};
  for (const d of chainDepths) chainHist[d] = (chainHist[d] ?? 0) + 1;
  console.log(`\nSupersede chains (same claim revised over time):`);
  console.log(`  facts that supersede an older one: ${supersededCount} / ${facts.length} (${(100 * supersededCount / facts.length).toFixed(0)}%)`);
  console.log(`  max chain length: ${maxChain}  | chain-length histogram (len:count): ${Object.entries(chainHist).sort((a, b) => +a[0] - +b[0]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
}

function histogram(sorted: number[]): string {
  const h: Record<number, number> = {};
  for (const d of sorted) h[d] = (h[d] ?? 0) + 1;
  return Object.entries(h).sort((a, b) => +a[0] - +b[0]).map(([k, v]) => `${k}:${v}`).join('  ');
}

function bfsMaxDepth(adj: Map<string, Set<string>>): number {
  let max = 0;
  for (const start of adj.keys()) {
    const dist = new Map<string, number>([[start, 0]]);
    const q = [start];
    while (q.length) {
      const n = q.shift()!;
      for (const nb of adj.get(n) ?? []) if (!dist.has(nb)) { dist.set(nb, dist.get(n)! + 1); q.push(nb); }
    }
    max = Math.max(max, ...dist.values());
  }
  return max;
}

main().catch((e) => { console.error(e); process.exit(1); });
