/**
 * Step 1: where do Sudden's facts actually come from, and what do they say?
 * Buckets facts created in the last N days by the signal type / source that
 * produced them, then dumps predicate distributions per bucket.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const DAYS = Number(process.argv[2] ?? 7);

async function fetchAll<T>(build: (f: number, t: number) => any): Promise<T[]> {
  let out: T[] = []; let f = 0; const pg = 1000;
  for (;;) { const { data, error } = await build(f, f + pg - 1); if (error) throw error; if (!data?.length) break; out = out.concat(data); if (data.length < pg) break; f += pg; }
  return out;
}

(async () => {
  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
  const facts = await fetchAll<any>((f, t) => sb.from('facts')
    .select('id, predicate, object_text, confidence, signal_id, subject_entity, created_at, supersedes')
    .eq('workspace_id', WS).gte('created_at', since).order('created_at', { ascending: false }).range(f, t));
  console.log(`facts created last ${DAYS}d: ${facts.length}`);
  console.log(`  active (not superseded away): ${facts.filter((f) => !f.supersedes).length}`);

  const sigIds = [...new Set(facts.map((f) => f.signal_id).filter(Boolean))];
  const sigMeta = new Map<string, any>();
  for (let i = 0; i < sigIds.length; i += 400) {
    const r = await sb.from('signals').select('id, type, structured_tags, observed_at').in('id', sigIds.slice(i, i + 400));
    for (const s of r.data ?? []) sigMeta.set(s.id, s);
  }

  const bucketOf = (f: any) => {
    if (!f.signal_id) return 'no_signal (scorer / import / system)';
    const s = sigMeta.get(f.signal_id);
    if (!s) return 'signal_deleted';
    return `${s.type}/${s.structured_tags?.signal_source ?? '-'}`;
  };

  const buckets = new Map<string, any[]>();
  for (const f of facts) { const b = bucketOf(f); if (!buckets.has(b)) buckets.set(b, []); buckets.get(b)!.push(f); }
  console.log('\n=== facts by originating signal bucket ===');
  for (const [b, arr] of [...buckets.entries()].sort((a, b2) => b2[1].length - a[1].length)) {
    console.log(`  ${String(arr.length).padStart(6)}  ${b}`);
  }

  for (const [b, arr] of [...buckets.entries()].sort((a, b2) => b2[1].length - a[1].length).slice(0, 4)) {
    const d = new Map<string, number>();
    for (const f of arr) d.set(f.predicate, (d.get(f.predicate) ?? 0) + 1);
    console.log(`\n--- top predicates in bucket "${b}" (${arr.length} facts, ${d.size} distinct predicates) ---`);
    for (const [p, c] of [...d.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 30)) console.log(`  ${String(c).padStart(5)}  ${p}`);
  }
})();
