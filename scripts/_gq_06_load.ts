/**
 * Step 6: how many active facts does the drafter actually read per account, and
 * how many of them could ever be used? agent_logic loads EVERY active fact on
 * the entity with no limit and renders one line each.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function fetchAll<T>(build: (f: number, t: number) => any): Promise<T[]> {
  let out: T[] = []; let f = 0; const pg = 1000;
  for (;;) { const { data, error } = await build(f, f + pg - 1); if (error) throw error; if (!data?.length) break; out = out.concat(data); if (data.length < pg) break; f += pg; }
  return out;
}
const isSystem = (p: string, o: string | null) => p.startsWith('score_') || p === 'icp_fit' || p === 'icp_fit_breakdown' || p.endsWith('_breakdown') || p === 'contact_lookup_attempted' || p === 'dropped_until' || /^[[{]/.test((o ?? '').trim()) || /^-?\d+(\.\d+)?$/.test((o ?? '').trim());

(async () => {
  // Top accounts by icp_fit — the ones that will actually get drafted.
  const top = await fetchAll<any>((f, t) => sb.from('facts').select('subject_entity, object_text')
    .eq('workspace_id', WS).eq('predicate', 'icp_fit').is('supersedes', null).range(f, t));
  const ranked = top.map((r) => ({ id: r.subject_entity, fit: Number(r.object_text) }))
    .filter((r) => Number.isFinite(r.fit)).sort((a, b) => b.fit - a.fit).slice(0, 15);

  const names = new Map<string, string>();
  const r = await sb.from('entities').select('id, name').in('id', ranked.map((x) => x.id));
  for (const e of r.data ?? []) names.set(e.id, e.name);

  console.log('account                     fit   active_facts  system  usable  distinct_predicates  prompt_chars');
  let totUsable = 0, totActive = 0;
  for (const a of ranked) {
    const rows = await fetchAll<any>((f, t) => sb.from('facts')
      .select('id, predicate, object_text, supersedes').eq('subject_entity', a.id).range(f, t));
    const sup = new Set(rows.map((x) => x.supersedes).filter(Boolean));
    const active = rows.filter((x) => !sup.has(x.id));
    const sys = active.filter((x) => isSystem(x.predicate, x.object_text));
    const usable = active.filter((x) => !isSystem(x.predicate, x.object_text));
    const preds = new Set(usable.map((x) => x.predicate));
    const chars = active.reduce((n, x) => n + `  ${x.id} | ${x.predicate}=${x.object_text} (conf=0.95)`.length, 0);
    totUsable += usable.length; totActive += active.length;
    console.log(`${(names.get(a.id) ?? '?').slice(0, 26).padEnd(26)} ${a.fit.toFixed(2)}  ${String(active.length).padStart(11)}  ${String(sys.length).padStart(6)}  ${String(usable.length).padStart(6)}  ${String(preds.size).padStart(19)}  ${String(chars).padStart(12)}`);
  }
  console.log(`\nTOP-15 TOTAL active=${totActive} usable=${totUsable}  (~${Math.round(totActive / 15)} fact lines per drafter prompt)`);

  // Whole-book predicate cardinality: how much vocabulary sprawl exists.
  const all = await fetchAll<any>((f, t) => sb.from('facts').select('predicate, supersedes, id').eq('workspace_id', WS).range(f, t));
  const supAll = new Set(all.map((x) => x.supersedes).filter(Boolean));
  const act = all.filter((x) => !supAll.has(x.id));
  const d = new Map<string, number>();
  for (const x of act) d.set(x.predicate, (d.get(x.predicate) ?? 0) + 1);
  const singles = [...d.values()].filter((v) => v === 1).length;
  console.log(`\nWHOLE BOOK: ${act.length} active facts, ${d.size} distinct predicates, ${singles} predicates used exactly once (${((singles / d.size) * 100).toFixed(0)}%)`);
})();
