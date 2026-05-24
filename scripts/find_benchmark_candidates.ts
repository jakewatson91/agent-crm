import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function main() {
  const ws = await supabase.from('workspaces').select('id, name').like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  if (ws.error) throw ws.error;
  console.log(`workspace: ${ws.data.name} (${ws.data.id})\n`);
  const wsId = ws.data.id as string;

  const accounts = await supabase.from('entities').select('id, name, created_at').eq('workspace_id', wsId).eq('kind', 'account');
  if (accounts.error) throw accounts.error;
  console.log(`total accounts: ${accounts.data.length}`);

  // Pull ALL facts at once, then bucket by subject/object
  const facts = await supabase.from('facts').select('id, subject_entity, object_entity, predicate').eq('workspace_id', wsId);
  if (facts.error) throw facts.error;
  console.log(`total facts: ${facts.data.length}`);

  // Pull ALL signals
  const signals = await supabase.from('signals').select('id, entity_id').eq('workspace_id', wsId);
  if (signals.error) throw signals.error;
  console.log(`total signals: ${signals.data.length}\n`);

  // Bucket
  const factCount = new Map<string, number>();
  const contactCount = new Map<string, number>();
  for (const f of facts.data) {
    const subj = f.subject_entity as string | null;
    if (subj) factCount.set(subj, (factCount.get(subj) ?? 0) + 1);
    if (f.predicate === 'works_at') {
      const acc = f.object_entity as string | null;
      if (acc) contactCount.set(acc, (contactCount.get(acc) ?? 0) + 1);
    }
  }
  const signalCount = new Map<string, number>();
  for (const s of signals.data) {
    const ent = s.entity_id as string | null;
    if (ent) signalCount.set(ent, (signalCount.get(ent) ?? 0) + 1);
  }

  const rows = accounts.data.map((a) => {
    const id = a.id as string;
    return {
      name: a.name as string,
      facts: factCount.get(id) ?? 0,
      contacts: contactCount.get(id) ?? 0,
      signals: signalCount.get(id) ?? 0,
      created: (a.created_at as string).slice(0, 10),
    };
  });
  rows.sort((a, b) => (b.facts + b.signals + b.contacts * 2) - (a.facts + a.signals + a.contacts * 2));
  console.log('top 25 accounts by (facts + signals + 2×contacts):');
  console.log('name                              facts  contacts  signals  created');
  console.log('----                              -----  --------  -------  -------');
  for (const r of rows.slice(0, 25)) {
    console.log(`${r.name.slice(0,34).padEnd(34)} ${String(r.facts).padStart(5)}  ${String(r.contacts).padStart(8)}  ${String(r.signals).padStart(7)}  ${r.created}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
