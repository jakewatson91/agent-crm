import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  const nm = new Map<string, string>();
  const resolve = async (ids: string[]) => { const m = [...new Set(ids)].filter((i) => i && !nm.has(i)); for (let i = 0; i < m.length; i += 200) { const r = await sb.from('entities').select('id, name').in('id', m.slice(i, i + 200)); for (const e of r.data ?? []) nm.set(e.id as string, e.name as string); } };

  // 1. what does is_a actually say?
  const isa = (await sb.from('facts').select('subject_entity, object_text, object_entity').eq('workspace_id', ws).eq('predicate', 'is_a').limit(10)).data ?? [];
  await resolve(isa.flatMap((f: any) => [f.subject_entity, f.object_entity].filter(Boolean)));
  console.log('=== is_a facts (how entity TYPE is now stored, since entities.kind was dropped) ===');
  for (const f of isa as any[]) console.log(`  [${nm.get(f.subject_entity)}] is_a "${f.object_text}"${f.object_entity ? ` ->[${nm.get(f.object_entity)}]` : ''}`);
  const isaObjs: Record<string, number> = {};
  for (const f of ((await sb.from('facts').select('object_text').eq('workspace_id', ws).eq('predicate', 'is_a').range(0, 1000)).data ?? []) as any[]) isaObjs[f.object_text] = (isaObjs[f.object_text] ?? 0) + 1;
  console.log('  is_a value distribution:', JSON.stringify(isaObjs));

  // 2. customer_of: scalar vs edge split (the #1 finding)
  const co = (await sb.from('facts').select('object_text, object_entity').eq('workspace_id', ws).eq('predicate', 'customer_of').range(0, 1000)).data ?? [];
  const coScalar = co.filter((f: any) => f.object_entity == null).length;
  const coEdge = co.filter((f: any) => f.object_entity != null).length;
  console.log(`\n=== customer_of write-shape ===`);
  console.log(`  as TEXT (object_text, invisible to graph.ts): ${coScalar}`);
  console.log(`  as EDGE (object_entity, what graph.ts reads):   ${coEdge}`);
  console.log('  sample text values:', (co as any[]).filter((f) => f.object_text).slice(0, 5).map((f) => `"${f.object_text}"`).join(' | '));

  // 3. provenance coverage + one clean walk
  const sample = (await sb.from('facts').select('id, predicate, source_event_id, signal_id').eq('workspace_id', ws).range(0, 1500)).data ?? [];
  const withEvent = sample.filter((f: any) => f.source_event_id != null).length;
  const withSignal = sample.filter((f: any) => f.signal_id != null).length;
  console.log(`\n=== provenance coverage (of ${sample.length} facts) ===`);
  console.log(`  have source_event_id: ${withEvent}  | have signal_id (newer direct link): ${withSignal}`);

  const f = (sample as any[]).find((x) => x.signal_id);
  if (f) {
    const sig = (await sb.from('signals').select('id, type, source_event_id, structured_tags, body_for_embedding').eq('id', f.signal_id).single()).data as any;
    console.log(`\n  walk via signal_id: fact ${f.id.slice(0,8)} (${f.predicate})`);
    console.log(`   -> signal ${String(f.signal_id).slice(0,8)} type=${sig?.type} source_id=${sig?.structured_tags?.source_id?.slice?.(0,8)} body="${String(sig?.body_for_embedding ?? '').slice(0,50)}..."`);
    const srcId = sig?.structured_tags?.source_id;
    if (srcId) { const s = (await sb.from('sources').select('name, connector_type').eq('id', srcId).single()).data as any; console.log(`   -> source name="${s?.name}" connector=${s?.connector_type}`); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
