import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

(async () => {
  // Any fact whose object_text mentions agentmail.to (email facts, etc.)
  const { data: f } = await db.from('facts')
    .select('id, subject_entity, predicate, object_text, supersedes')
    .eq('workspace_id', ws).ilike('object_text', '%agentmail.to%');
  console.log(`facts mentioning agentmail.to: ${f?.length ?? 0}`);
  const subjects = new Set<string>();
  for (const r of (f ?? []) as any[]) {
    console.log(`  fact=${r.id.slice(0,8)} subj=${r.subject_entity?.slice(0,8)} pred=${r.predicate} text=${r.object_text} superseded=${!!r.supersedes}`);
    if (r.subject_entity) subjects.add(r.subject_entity);
  }

  // Any entity whose attributes blob mentions agentmail (email stored in attributes)
  const { data: ents } = await db.from('entities').select('id, name, attributes').eq('workspace_id', ws).limit(5000);
  const hit = (ents ?? []).filter((e: any) => JSON.stringify(e.attributes ?? {}).includes('agentmail'));
  console.log(`\nentities with 'agentmail' in attributes: ${hit.length}`);
  for (const e of hit) { console.log(`  ent=${e.id.slice(0,8)} name="${e.name}" attrs=${JSON.stringify(e.attributes)}`); subjects.add(e.id); }

  // Entities named like the three local-parts (case-insensitive, partial)
  for (const needle of ['settlementradar', 'ocean-tiger', 'ocean tiger', 'alan.botts', 'alan botts', 'botts']) {
    const { data: n } = await db.from('entities').select('id, name').eq('workspace_id', ws).ilike('name', `%${needle}%`);
    if (n?.length) for (const e of n as any[]) { console.log(`  name match "${needle}": ent=${e.id.slice(0,8)} name="${e.name}"`); subjects.add(e.id); }
  }

  console.log(`\ndistinct candidate entities found: ${subjects.size}`);
  for (const id of subjects) {
    const { data: ent } = await db.from('entities').select('id, name, attributes').eq('id', id).maybeSingle();
    const { data: allf } = await db.from('facts').select('predicate, object_text, supersedes').eq('workspace_id', ws).eq('subject_entity', id);
    const active = (allf ?? []).filter((x: any) => true);
    console.log(`\n  ENTITY ${id} name="${ent?.name}"`);
    console.log(`    is_a: ${JSON.stringify((allf??[]).filter((x:any)=>x.predicate==='is_a').map((x:any)=>x.object_text))}`);
    console.log(`    facts: ${active.length} → ${(allf??[]).map((x:any)=>`${x.predicate}=${x.object_text}`).slice(0,12).join(' | ')}`);
  }
})();
