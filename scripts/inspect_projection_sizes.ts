import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const accounts = ['Resona Labs', 'Forge Robotics', 'Plaintext.so', 'Halo Health', 'Brightvine', 'Strand Compute'];

async function main() {
  const ws = await supabase
    .from('workspaces')
    .select('id')
    .like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  console.log(`${'account'.padEnd(20)} ${'facts'.padStart(6)} ${'sigs'.padStart(5)} ${'attrs_chars'.padStart(12)} ${'facts_chars'.padStart(12)} ${'sigs_chars'.padStart(12)} ${'total_chars'.padStart(12)}`);
  for (const name of accounts) {
    const ent = await supabase
      .from('entities').select('id,name,attributes')
      .eq('workspace_id', ws.data!.id).eq('kind', 'account').eq('name', name).single();
    const all = await supabase
      .from('facts').select('id,predicate,object_text,confidence,supersedes')
      .eq('workspace_id', ws.data!.id).eq('subject_entity', ent.data!.id);
    const supSet = new Set((all.data ?? []).map((f) => f.supersedes as string | null).filter((x): x is string => !!x));
    const facts = (all.data ?? []).filter((f) => !supSet.has(f.id as string));
    const sigs = await supabase
      .from('signals').select('id,type,magnitude,body_for_embedding,observed_at')
      .eq('workspace_id', ws.data!.id).eq('entity_id', ent.data!.id)
      .order('observed_at', { ascending: false }).limit(20);

    const projection = {
      account: { id: ent.data!.id, name: ent.data!.name, attributes: ent.data!.attributes },
      facts: facts.map((f) => ({ id: f.id, predicate: f.predicate, object: f.object_text, confidence: f.confidence })),
      signals: (sigs.data ?? []).map((s) => ({ id: s.id, type: s.type, magnitude: s.magnitude, body: s.body_for_embedding, observed_at: s.observed_at })),
    };
    const attrsStr = JSON.stringify(projection.account.attributes);
    const factsStr = JSON.stringify(projection.facts);
    const sigsStr = JSON.stringify(projection.signals);
    const total = JSON.stringify(projection);
    console.log(`${name.padEnd(20)} ${String(facts.length).padStart(6)} ${String((sigs.data ?? []).length).padStart(5)} ${String(attrsStr.length).padStart(12)} ${String(factsStr.length).padStart(12)} ${String(sigsStr.length).padStart(12)} ${String(total.length).padStart(12)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
