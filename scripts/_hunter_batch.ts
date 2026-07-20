import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { findContacts } from '@agent-crm/tools';
import { writeFileSync } from 'node:fs';

// 6 hiring-signal + 4 clean non-competitor YC accounts. Skips outreach-tool competitors.
const DOMAINS = [
  'hud.ai', 'furtherai.com', 'useflai.com', 'avallon.ai', 'noxmetals.co', 'aquavoice.com',
  'fleetline.ai', 'workweave.dev', 'fromolive.com', 'uplane.com',
];

async function main() {
  if (!process.env.HUNTER_API_KEY) throw new Error('HUNTER_API_KEY not set');
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;

  // resolve entity ids by domain
  const ents: any[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await sb.from('entities').select('id, name, attributes').eq('workspace_id', ws).range(from, from + 999);
    const rows = (r.data ?? []) as any[]; ents.push(...rows);
    if (rows.length < 1000) break;
  }
  const byDomain = new Map<string, { id: string; name: string }>();
  for (const e of ents) { const d = e.attributes?.domain; if (d) byDomain.set(String(d).toLowerCase(), { id: e.id, name: e.name }); }

  const out: any[] = [];
  let credits = 0;
  for (const domain of DOMAINS) {
    const ent = byDomain.get(domain);
    if (!ent) { console.log(`\n✗ ${domain} — no matching entity, SKIP (no credit spent)`); continue; }
    try {
      const contacts = await findContacts({ domain, limit: 5, role_filter: 'founder' });
      credits++;
      console.log(`\n● ${ent.name}  (${domain})  [credit ${credits}]`);
      if (!contacts.length) { console.log('   — no contacts returned'); }
      for (const c of contacts) console.log(`   ${c.name.padEnd(24).slice(0,24)} ${c.email.padEnd(34)} ${(c.role||'(no role)').slice(0,28).padEnd(28)} conf=${c.source_confidence.toFixed(2)}`);
      out.push({ domain, entity_id: ent.id, account_name: ent.name, contacts });
    } catch (e) {
      console.log(`\n✗ ${ent.name} (${domain}) — ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  writeFileSync('scripts/_hunter_results.json', JSON.stringify(out, null, 2));
  console.log(`\n=== spent ${credits} credits | ${out.length} companies | cached to scripts/_hunter_results.json (NOT yet linked) ===`);
  const withContacts = out.filter((o) => o.contacts.length).length;
  console.log(`companies with >=1 contact: ${withContacts}/${out.length}`);
}
main().catch((e) => { console.error('✗', e instanceof Error ? e.message : e); process.exit(1); });
