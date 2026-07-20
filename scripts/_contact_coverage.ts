import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;

  // is_a sets
  async function idsOfType(t: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const r = await sb.from('facts').select('subject_entity').eq('workspace_id', ws).eq('predicate', 'is_a').eq('object_text', t).range(from, from + 999);
      const rows = (r.data ?? []) as any[];
      for (const f of rows) out.add(f.subject_entity);
      if (rows.length < 1000) break;
    }
    return out;
  }
  const acctIds = await idsOfType('account');
  const contactIds = await idsOfType('contact');

  // pull contact entities to check email presence
  const ents: any[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await sb.from('entities').select('id, name, attributes').eq('workspace_id', ws).range(from, from + 999);
    const rows = (r.data ?? []) as any[];
    ents.push(...rows);
    if (rows.length < 1000) break;
  }
  const contacts = ents.filter((e) => contactIds.has(e.id));
  const withEmail = contacts.filter((e) => e.attributes?.email);

  // works_at edges: contact -> account
  const worksAt = new Map<string, string>(); // contact -> account
  for (let from = 0; ; from += 1000) {
    const r = await sb.from('facts').select('subject_entity, object_entity').eq('workspace_id', ws).eq('predicate', 'works_at').range(from, from + 999);
    const rows = (r.data ?? []) as any[];
    for (const f of rows) if (f.object_entity) worksAt.set(f.subject_entity, f.object_entity);
    if (rows.length < 1000) break;
  }
  const acctsWithContact = new Set<string>();
  for (const [, acct] of worksAt) if (acctIds.has(acct)) acctsWithContact.add(acct);
  // also count via email-domain match would be extra; keep to explicit edges

  console.log(`accounts:           ${acctIds.size}`);
  console.log(`contacts:           ${contacts.length}`);
  console.log(`contacts w/ email:  ${withEmail.length}`);
  console.log(`accounts w/ >=1 contact (works_at edge): ${acctsWithContact.size}  (${(100*acctsWithContact.size/Math.max(acctIds.size,1)).toFixed(1)}% of accounts)`);
  console.log(`accounts with ZERO contacts: ${acctIds.size - acctsWithContact.size}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
