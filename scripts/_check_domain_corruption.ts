import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = '7c4f79b1-518f-4e64-b634-f61aa14b88d2';
(async () => {
  const rows: Array<{ id: string; name: string; attributes: any }> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from('entities').select('id, name, attributes').eq('workspace_id', WS).range(from, from + 999);
    rows.push(...((data ?? []) as any[]));
    if (!data || data.length < 1000) break;
  }
  console.log('total entities (paginated):', rows.length);

  const badDomains = ['linkedin.com', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com'];
  const poisoned = rows.filter(r => badDomains.includes((r.attributes?.domain ?? '').toLowerCase()));
  console.log('poisoned hub accounts (domain = a social platform):', poisoned.length);
  console.log(JSON.stringify(poisoned.map(p => ({ id: p.id, name: p.name, domain: p.attributes?.domain })), null, 2));

  for (const p of poisoned) {
    const facts = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', WS).eq('subject_entity', p.id);
    const contacts = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', WS).eq('predicate', 'works_at').eq('object_entity', p.id);
    console.log(`  ${p.name} (${p.attributes?.domain}): ${facts.count} facts, ${contacts.count} contacts merged in`);
  }

  // also check for duplicate account NAMES (same name, multiple ids -- would
  // indicate the OTHER failure mode: same company failed to dedupe at all)
  const byName = new Map<string, number>();
  for (const r of rows) byName.set(r.name, (byName.get(r.name) ?? 0) + 1);
  const dupeNames = [...byName.entries()].filter(([, c]) => c > 1);
  console.log('\nduplicate account names:', dupeNames.length, dupeNames.slice(0, 10));
})();
