import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { linkContactToAccount } from '@agent-crm/tools';
import { readFileSync } from 'node:fs';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;

  // 1) link the contacts we actually got
  const results = JSON.parse(readFileSync('scripts/_hunter_results.json', 'utf8')) as any[];
  const actor = { workspace_id: ws, actor_kind: 'agent' as const, actor_id: 'source:hunter:batch' };
  let linked = 0;
  for (const r of results) {
    for (const c of (r.contacts ?? [])) {
      const res = await linkContactToAccount(sb, actor, { account_entity_id: r.entity_id, name: c.name, email: c.email, role: c.role });
      console.log(`  ${res.created ? 'CREATED' : 'exists '} ${c.name} <${c.email}> @ ${r.account_name}`);
      if (res.created) linked++;
    }
  }
  console.log(`linked ${linked} new contact(s)\n`);

  // 2) assess Hunter-coverage potential: yc_batch distribution among contactless accounts
  async function pagedFacts(pred: string, obj?: string) {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from('facts').select('subject_entity, object_entity').eq('workspace_id', ws).eq('predicate', pred).range(from, from + 999);
      if (obj) q = q.eq('object_text', obj);
      const rows = ((await q).data ?? []) as any[]; out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  }
  const acctIds = new Set((await pagedFacts('is_a', 'account')).map((f) => f.subject_entity));
  const withContact = new Set((await pagedFacts('works_at')).filter((f) => f.object_entity && acctIds.has(f.object_entity)).map((f) => f.object_entity));
  const ents: any[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = ((await sb.from('entities').select('id, attributes').eq('workspace_id', ws).range(from, from + 999)).data ?? []) as any[];
    ents.push(...rows); if (rows.length < 1000) break;
  }
  const contactless = ents.filter((e) => acctIds.has(e.id) && !withContact.has(e.id));
  const byBatch: Record<string, number> = {};
  let nonYC = 0;
  for (const e of contactless) {
    const b = e.attributes?.yc_batch;
    if (!b) { nonYC++; continue; }
    const yr = String(b).match(/20\d\d/)?.[0] ?? 'other';
    byBatch[yr] = (byBatch[yr] ?? 0) + 1;
  }
  console.log('contactless account YC-batch-year distribution (older = better Hunter coverage):');
  for (const [yr, n] of Object.entries(byBatch).sort()) console.log(`  ${yr}: ${n}`);
  console.log(`  non-YC (other sources): ${nonYC}`);
}
main().catch((e) => { console.error('✗', e instanceof Error ? e.message : e); process.exit(1); });
