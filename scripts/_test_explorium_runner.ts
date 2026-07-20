import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { findContactsExplorium, linkContactToAccount, scoreAndAssert, getPolicy, resolveEnvVar } from '@agent-crm/tools';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const wsRow = ((await sb.from('workspaces').select('id').limit(50)).data ?? []).find((x:any)=> String(x.id).startsWith('af602fa1')) as any;
  const workspace_id = wsRow.id;
  // Find EarthaPro account
  const ent = (await sb.from('entities').select('id, name, attributes').eq('workspace_id', workspace_id).ilike('name', '%earthapro%').limit(1)).data?.[0] as any;
  if (!ent) { console.log('EarthaPro not found'); return; }
  const entity_id = ent.id;
  const domain = ent.attributes?.domain;
  console.log('account:', ent.name, entity_id, 'domain:', domain);

  const actor = { workspace_id, actor_kind: 'agent' as const, actor_id: 'contacts_runner' };
  const policy = await getPolicy(sb, workspace_id);
  const apiKey = resolveEnvVar(policy, 'EXPLORIUM_API_KEY');
  console.log('key resolved via policy/env:', !!apiKey);

  async function runOnce(label: string) {
    const pulled = await findContactsExplorium({ domain, apiKey: apiKey!, limit: 5, role_filter: 'founder' });
    let created = 0;
    for (const c of pulled) {
      const r = await linkContactToAccount(sb, actor, { account_entity_id: entity_id, name: c.name, email: c.email, role: c.role });
      if (r.created) { await scoreAndAssert(sb, actor, r.contact_entity_id); created++; }
    }
    console.log(`[${label}] pulled ${pulled.length}, created ${created}`);
  }
  await runOnce('run1');
  await runOnce('run2 (idempotency)');
}
main().catch((e)=>{console.error('ERR:', e.message);});
