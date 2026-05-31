import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  const cands = (await sb.from('entities').select('id, name').eq('workspace_id', ws).eq('attributes->>candidate', 'true')).data ?? [];
  const junk = (await sb.from('entities').select('id, name').eq('workspace_id', ws).ilike('name', '%onboarding new clients%')).data ?? [];
  const zzz = (await sb.from('entities').select('id, name').eq('workspace_id', ws).ilike('name', 'Zzztest%')).data ?? [];
  console.log('leftover candidate entities:', cands.length, (cands as any[]).map((c) => c.name));
  console.log('leftover junk entities:', junk.length, (junk as any[]).map((c) => c.name));
  console.log('leftover Zzztest entities:', zzz.length, (zzz as any[]).map((c) => c.name));
}
main().catch((e) => { console.error(e); process.exit(1); });
