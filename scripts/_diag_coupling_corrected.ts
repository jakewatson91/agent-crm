import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const now = Date.now();
const DAY = 86_400_000;
const cutoff = new Date(now - DAY).toISOString();

async function fetchAll<T>(q: (f: number, t: number) => any): Promise<T[]> {
  const out: T[] = []; let f = 0; const n = 1000;
  for (;;) { const { data, error } = await q(f, f + n - 1); if (error) throw error; const r = (data ?? []) as T[]; out.push(...r); if (r.length < n) break; f += n; }
  return out;
}

// The current/active fact = the one NOT pointed at by any other row's `supersedes`.
// `.is('supersedes', null)` returns the ORIGINAL (oldest) — wrong for current state.
function currentObservedAt(rows: Array<{ id: string; supersedes: string | null; observed_at: string }>): string | null {
  if (!rows.length) return null;
  const pointedTo = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
  const active = rows.filter((r) => !pointedTo.has(r.id));
  if (!active.length) return null;
  return active.reduce((m, r) => (r.observed_at > m ? r.observed_at : m), '');
}

async function main() {
  const disp = await fetchAll<{ target_id: string | null; payload: any }>((f, t) => sb.from('events')
    .select('target_id, payload').eq('workspace_id', ws).eq('action', 'agent_dispatch_result').gte('created_at', cutoff).order('id').range(f, t));
  const ids = [...new Set(disp.filter((d) => d.payload?.behavior === 'enricher' && (d.payload?.facts_asserted ?? 0) > 0 && d.target_id).map((d) => d.target_id as string))];

  // all icp_fit rows (incl superseded) for those entities
  const icp = await fetchAll<{ subject_entity: string; id: string; supersedes: string | null; observed_at: string }>((f, t) => sb.from('facts')
    .select('subject_entity, id, supersedes, observed_at').eq('workspace_id', ws).eq('predicate', 'icp_fit').in('subject_entity', ids).order('id').range(f, t));
  const byEnt = new Map<string, Array<{ id: string; supersedes: string | null; observed_at: string }>>();
  for (const r of icp) { const a = byEnt.get(r.subject_entity) ?? []; a.push(r); byEnt.set(r.subject_entity, a); }

  let movedWrong = 0, movedRight = 0, none = 0;
  // wrong = .is('supersedes',null) method (what the sweep does)
  const origByEnt = new Map<string, string>();
  for (const r of icp) if (r.supersedes === null) origByEnt.set(r.subject_entity, r.observed_at);

  for (const id of ids) {
    const rows = byEnt.get(id) ?? [];
    if (!rows.length) { none += 1; continue; }
    const wrong = origByEnt.get(id);              // sweep's reading (original)
    const right = currentObservedAt(rows);        // true current
    if (wrong && wrong >= cutoff) movedWrong += 1;
    if (right && right >= cutoff) movedRight += 1;
  }
  const n = ids.length;
  console.log(`entities with new facts (24h) = ${n}`);
  console.log(`  no icp_fit at all (true gap / unpromoted candidate) = ${none}`);
  console.log(`\ncoupling AS THE SWEEP MEASURES IT (.is supersedes null -> original) = ${movedWrong}/${n} (${(100*movedWrong/n).toFixed(0)}%)  [RED if <50%]`);
  console.log(`coupling CORRECTED (current not-pointed-to fact)             = ${movedRight}/${n} (${(100*movedRight/n).toFixed(0)}%)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
