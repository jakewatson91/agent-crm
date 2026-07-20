import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function main() {
  const wss = await sb.from('workspaces').select('id, name').order('created_at', { ascending: true });
  for (const ws of wss.data ?? []) {
    const m = await sb.from('workspace_members').select('user_id, role, created_at').eq('workspace_id', ws.id).order('created_at', { ascending: true });
    const rows = m.data ?? [];
    if (!rows.length) { console.log(`${ws.name} (${ws.id.slice(0, 8)}): NO MEMBERS`); continue; }
    for (const r of rows) {
      const u = await sb.auth.admin.getUserById(r.user_id);
      console.log(`${ws.name} (${ws.id.slice(0, 8)}): role=${r.role} email=${u.data?.user?.email ?? 'NO EMAIL'}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
