import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { linkContactToAccount } from '@agent-crm/tools';

// Founder/exec contacts pulled FREE from Vibe/Explorium enrich preview (valid pro emails),
// for the 6 YC companies Hunter returned nothing on (+ FurtherAI control).
const CONTACTS = [
  { domain: 'fromolive.com',  name: 'Bardia Safari',      email: 'bardia@fromolive.com', role: 'Co-founder & CEO' },
  { domain: 'noxmetals.co',   name: 'Zane Hengsperger',   email: 'zane@noxmetals.co',    role: 'Founder & CEO' },
  { domain: 'workweave.dev',  name: 'Andrew Churchill',   email: 'andrew@workweave.dev', role: 'Co-founder & CTO' },
  { domain: 'uplane.com',     name: 'Marvin Abdel-massih',email: 'marvin@uplane.com',    role: 'Co-founder' },
  { domain: 'fleetline.ai',   name: 'Saurav Kumar',       email: 'saurav@fleetline.ai',  role: 'Co-founder & CEO' },
  { domain: 'avallon.ai',     name: 'Yasi Jannetta',      email: 'yasi@avallon.ai',      role: 'Chief of Staff' },
  { domain: 'furtherai.com',  name: 'Shariq Memon',       email: 'shariq@furtherai.com', role: 'Chief of Staff' },
];

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  const ents: any[] = [];
  for (let from = 0; ; from += 1000) { const rows = ((await sb.from('entities').select('id, name, attributes').eq('workspace_id', ws).range(from, from + 999)).data ?? []) as any[]; ents.push(...rows); if (rows.length < 1000) break; }
  const byDomain = new Map<string, { id: string; name: string }>();
  for (const e of ents) { const d = e.attributes?.domain; if (d) byDomain.set(String(d).toLowerCase(), { id: e.id, name: e.name }); }

  const actor = { workspace_id: ws, actor_kind: 'agent' as const, actor_id: 'source:vibe:explorium' };
  let created = 0;
  for (const c of CONTACTS) {
    const ent = byDomain.get(c.domain);
    if (!ent) { console.log(`✗ ${c.domain} — no entity, skip`); continue; }
    const res = await linkContactToAccount(sb, actor, { account_entity_id: ent.id, name: c.name, email: c.email, role: c.role });
    console.log(`  ${res.created ? 'CREATED' : 'exists '} ${c.name.padEnd(20)} <${c.email.padEnd(26)}> @ ${ent.name}`);
    if (res.created) created++;
  }
  console.log(`\nlinked ${created} new founder/exec contacts via Vibe (0 credits spent)`);
}
main().catch((e) => { console.error('✗', e instanceof Error ? e.message : e); process.exit(1); });
