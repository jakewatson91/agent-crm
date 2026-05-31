import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const wsAll = await sb.from('workspaces').select('id, name');
  const ws = (wsAll.data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;

  const nameOf = new Map<string, string>();
  const resolve = async (ids: string[]) => {
    const miss = [...new Set(ids)].filter((i) => i && !nameOf.has(i));
    for (let i = 0; i < miss.length; i += 200) {
      const r = await sb.from('entities').select('id, name').in('id', miss.slice(i, i + 200));
      for (const e of r.data ?? []) nameOf.set(e.id as string, e.name as string);
    }
  };

  // live column names
  const oneFact = (await sb.from('facts').select('*').eq('workspace_id', ws).limit(1)).data?.[0] ?? {};
  const oneEnt = (await sb.from('entities').select('*').eq('workspace_id', ws).limit(1)).data?.[0] ?? {};
  console.log('FACTS columns :', Object.keys(oneFact).join(', '));
  console.log('ENTITIES columns:', Object.keys(oneEnt).join(', '));

  // one full entity row
  console.log('\n=== sample ENTITY row ===');
  console.log(JSON.stringify(oneEnt, null, 2));

  // scalar facts
  const scalars = (await sb.from('facts').select('id, subject_entity, predicate, object_text, confidence, observed_at').eq('workspace_id', ws).not('object_text', 'is', null).is('object_entity', null).limit(6)).data ?? [];
  await resolve(scalars.map((f: any) => f.subject_entity));
  console.log('\n=== SCALAR facts (object_text set, object_entity null) ===');
  for (const f of scalars as any[]) console.log(`  [${nameOf.get(f.subject_entity)}]  --${f.predicate}-->  "${f.object_text}"   (conf ${f.confidence})`);

  // edge facts
  const edges = (await sb.from('facts').select('id, subject_entity, predicate, object_entity, object_text, confidence').eq('workspace_id', ws).not('object_entity', 'is', null).limit(6)).data ?? [];
  await resolve(edges.flatMap((f: any) => [f.subject_entity, f.object_entity]));
  console.log('\n=== EDGE facts (object_entity set = pointer to another entity) ===');
  for (const f of edges as any[]) console.log(`  [${nameOf.get(f.subject_entity)}]  --${f.predicate}-->  [${nameOf.get(f.object_entity)}]   (object_text=${JSON.stringify(f.object_text)})`);

  // supersede pair
  const newer = (await sb.from('facts').select('id, subject_entity, predicate, object_text, observed_at, supersedes').eq('workspace_id', ws).not('supersedes', 'is', null).limit(3)).data ?? [];
  console.log('\n=== SUPERSEDE pair (same claim, revised) ===');
  for (const n of newer as any[]) {
    const old = (await sb.from('facts').select('id, predicate, object_text, observed_at').eq('id', n.supersedes).single()).data as any;
    await resolve([n.subject_entity]);
    console.log(`  subject [${nameOf.get(n.subject_entity)}] predicate "${n.predicate}":`);
    console.log(`    OLD fact ${old?.id?.slice(0,8)}  object_text="${old?.object_text}"  observed ${old?.observed_at}`);
    console.log(`    NEW fact ${n.id.slice(0,8)}  object_text="${n.object_text}"  observed ${n.observed_at}  (supersedes -> ${n.supersedes.slice(0,8)})`);
  }

  // provenance walk for one fact that has a source_event_id
  const withSrc = (await sb.from('facts').select('id, subject_entity, predicate, object_text, source_event_id').eq('workspace_id', ws).not('source_event_id', 'is', null).limit(1)).data?.[0] as any;
  console.log('\n=== PROVENANCE walk (fact -> event -> signal -> source) ===');
  if (withSrc) {
    await resolve([withSrc.subject_entity]);
    console.log(`  fact ${withSrc.id.slice(0,8)}: [${nameOf.get(withSrc.subject_entity)}] --${withSrc.predicate}--> "${withSrc.object_text}"`);
    const ev = (await sb.from('events').select('id, type, payload, created_at').eq('id', withSrc.source_event_id).single()).data as any;
    console.log(`  -> event ${String(ev?.id).slice(0,8)} type=${ev?.type} payload.keys=[${Object.keys(ev?.payload ?? {}).join(',')}] signal_id=${ev?.payload?.signal_id?.slice?.(0,8) ?? ev?.payload?.signal_id}`);
    const sigId = ev?.payload?.signal_id;
    if (sigId) {
      const sig = (await sb.from('signals').select('id, structured_tags, content').eq('id', sigId).single()).data as any;
      console.log(`  -> signal ${String(sigId).slice(0,8)} source_id=${sig?.structured_tags?.source_id?.slice?.(0,8)} content="${String(sig?.content ?? '').slice(0,60)}..."`);
      const srcId = sig?.structured_tags?.source_id;
      if (srcId) {
        const src = (await sb.from('sources').select('id, name, connector_type').eq('id', srcId).single()).data as any;
        console.log(`  -> source ${String(srcId).slice(0,8)} name="${src?.name}" connector=${src?.connector_type}`);
      }
    }
  }

  // distribution of scalar predicates (top 15) so Jake sees what "facts" actually are
  const all = (await sb.from('facts').select('predicate, object_entity').eq('workspace_id', ws).range(0, 4000)).data ?? [];
  const scalarPred: Record<string, number> = {};
  for (const f of all as any[]) if (!f.object_entity) scalarPred[f.predicate] = (scalarPred[f.predicate] ?? 0) + 1;
  console.log('\n=== top scalar predicates (what most facts actually say) ===');
  for (const [p, n] of Object.entries(scalarPred).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${p.padEnd(22)} ${n}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
