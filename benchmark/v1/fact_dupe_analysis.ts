import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { embed } from '@agent-crm/primitives';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.WS || 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
const admin = /(^score_|_breakdown$|^icp_fit|dropped_until|cooldown|_candidate|rescore|^lifecycle|^outreach_stage|marker|^email$|^role$|^domain$)/i;

async function main() {
  // Pull all fact rows, compute active set (not pointed-to by supersedes).
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from('facts')
      .select('id, subject_entity, predicate, object_text, supersedes')
      .eq('workspace_id', WS).order('id', { ascending: true }).range(from, from + 999);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const superseded = new Set(rows.map((r) => r.supersedes).filter(Boolean));
  const active = rows.filter((r) => !superseded.has(r.id) && r.object_text && !admin.test(r.predicate));

  // Group by (entity, predicate); keep groups with >=2 (candidate dup clusters).
  const groups = new Map<string, { predicate: string; texts: { id: string; t: string }[] }>();
  for (const f of active) {
    const k = `${f.subject_entity}::${f.predicate}`;
    const g = groups.get(k) ?? { predicate: f.predicate, texts: [] };
    g.texts.push({ id: f.id, t: f.object_text });
    groups.set(k, g);
  }
  const multi = [...groups.entries()].filter(([, g]) => g.texts.length >= 2);
  console.log(`\nActive substantive facts: ${active.length}`);
  console.log(`(entity,predicate) groups with >=2 facts: ${multi.length}  (these are the only places a fact-dup can exist)\n`);

  // Embed + pairwise cosine within each group. Cache embeds by text.
  const cache = new Map<string, number[]>();
  async function emb(t: string) { let v = cache.get(t); if (!v) { v = await embed(t.slice(0, 500)); cache.set(t, v); } return v; }
  const buckets = { '>=0.97': 0, '0.93-0.97': 0, '0.90-0.93': 0, '0.85-0.90': 0, '<0.85': 0 };
  const examples: { c: number; p: string; a: string; b: string }[] = [];
  const full: { c: number; p: string; a: string; b: string }[] = [];
  let pairs = 0, embN = 0;
  for (const [, g] of multi) {
    const vecs = await Promise.all(g.texts.map(async (x) => { embN++; return { id: x.id, t: x.t, v: await emb(x.t) }; }));
    for (let i = 0; i < vecs.length; i++) for (let j = i + 1; j < vecs.length; j++) {
      const c = cosine(vecs[i].v, vecs[j].v); pairs++;
      if (c >= 0.97) buckets['>=0.97']++; else if (c >= 0.93) buckets['0.93-0.97']++;
      else if (c >= 0.90) buckets['0.90-0.93']++; else if (c >= 0.85) buckets['0.85-0.90']++; else buckets['<0.85']++;
      if (c >= 0.85 && examples.length < 40) examples.push({ c, p: g.predicate, a: vecs[i].t.slice(0, 60), b: vecs[j].t.slice(0, 60) });
      if (c >= 0.92) full.push({ c, p: g.predicate, a: vecs[i].t, b: vecs[j].t });
    }
  }
  console.log(`Same-predicate same-entity pairs: ${pairs}  (embedded ${embN} facts, ${cache.size} unique)\n`);
  console.log('Cosine distribution of same-predicate fact pairs:');
  for (const [k, n] of Object.entries(buckets)) console.log(`  ${k.padEnd(11)} ${n}  ${'█'.repeat(Math.min(60, n))}`);
  // Full, UNTRUNCATED text for every pair >= 0.92 so the threshold can be derived
  // by labelling each pair dup/distinct and finding the highest distinct-pair cosine.
  console.log('\nAll pairs >= 0.92 (FULL text — label each dup/distinct to derive the floor):');
  for (const e of full.sort((a, b) => b.c - a.c)) {
    console.log(`\n  cos=${e.c.toFixed(4)}  [${e.p}]`);
    console.log(`    A: ${e.a}`);
    console.log(`    B: ${e.b}`);
  }
  console.log('');
}
main().catch((e) => { console.error(e); process.exit(1); });
