import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;

  // entities whose name is a generic literal the backfill matched
  const names = ['contact', 'account', 'product', 'Not specified', 'not specified', 'LiFast', 'SaaSOffers', 'SaasOffers'];
  for (const nm of names) {
    const ents = (await sb.from('entities').select('id, name, attributes, created_at').eq('workspace_id', ws).ilike('name', nm)).data ?? [];
    for (const e of ents as any[]) {
      const factCount = (await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('subject_entity', e.id)).count ?? 0;
      const hasDomain = !!e.attributes?.domain;
      console.log(`"${e.name}"  id=${e.id.slice(0, 8)}  facts=${factCount}  domain=${hasDomain ? e.attributes.domain : 'none'}  candidate=${e.attributes?.candidate ?? false}  created=${String(e.created_at).slice(0, 10)}`);
    }
  }

  // how many active is_a facts have object_text 'contact'/'account' (these would all wrongly become edges)
  for (const v of ['contact', 'account', 'product']) {
    const rows = (await sb.from('facts').select('id, supersedes').eq('workspace_id', ws).eq('predicate', 'is_a').eq('object_text', v)).data ?? [];
    const superseded = new Set((rows as any[]).map((r) => r.supersedes).filter(Boolean));
    const active = (rows as any[]).filter((r) => !superseded.has(r.id)).length;
    console.log(`active is_a="${v}" facts: ${active}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
