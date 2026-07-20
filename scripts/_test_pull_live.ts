import { createClient } from '@supabase/supabase-js';
import { pullContactsForAccount } from '@agent-crm/tools';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

const entity_id = process.argv[2] || '60f5a2b3-4879-41a7-9707-a32f48604fb0'; // StarSling

(async () => {
  const { data: ent } = await db.from('entities').select('name, attributes').eq('id', entity_id).maybeSingle();
  console.log(`PULL target: "${ent?.name}" domain=${(ent?.attributes as any)?.domain} entity=${entity_id}\n`);

  const t0 = Date.now();
  const r = await pullContactsForAccount(db, { workspace_id: ws, entity_id });
  console.log(`RESULT (${Date.now() - t0}ms):`, JSON.stringify(r));

  // Verify each stage landed.
  // 1. Linked contacts (works_at this account)
  const { data: links } = await db.from('facts')
    .select('subject_entity').eq('workspace_id', ws).eq('predicate', 'works_at').eq('object_entity', entity_id).is('supersedes', null);
  const contactIds = [...new Set((links ?? []).map((l: any) => l.subject_entity))];
  console.log(`\nlinked contacts: ${contactIds.length}`);
  for (const cid of contactIds) {
    const { data: ce } = await db.from('entities').select('name').eq('id', cid).maybeSingle();
    const { data: cf } = await db.from('facts').select('predicate, object_text, supersedes').eq('workspace_id', ws).eq('subject_entity', cid);
    const active = (cf ?? []).filter((f: any) => true);
    const pointed = new Set((cf ?? []).map((f: any) => f.supersedes).filter(Boolean));
    const cur = (cf ?? []).filter((f: any) => !pointed.has((f as any).id));
    const email = (cf ?? []).find((f: any) => f.predicate === 'email')?.object_text;
    const role = (cf ?? []).find((f: any) => f.predicate === 'role')?.object_text;
    const cscore = (cf ?? []).filter((f: any) => f.predicate === 'contact_score');
    console.log(`  • "${ce?.name}" email=${email ?? '(none)'} role=${role ?? '(none)'} contact_score_rows=${cscore.length} (${cscore.map((s:any)=>s.object_text).join('→')})`);
  }

  // 2. Audit fact
  const { data: comp } = await db.from('facts')
    .select('object_text, created_at').eq('workspace_id', ws).eq('predicate', 'contacts_completed').eq('subject_entity', entity_id).order('created_at', { ascending: false }).limit(3);
  console.log(`\ncontacts_completed audit facts (latest 3):`);
  for (const c of (comp ?? []) as any[]) console.log(`  ${c.created_at}  ${c.object_text}`);
})();
