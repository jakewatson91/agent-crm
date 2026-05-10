/**
 * The 4 source-specific drafter subscriptions are superseded by outbound_drafter,
 * which gates by icp_fit instead of signal_source. Deactivate them.
 * Reversible: set active=true to bring any back.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const LEGACY_DRAFTER_OWNERS = [
  'claims_audit_yc_drafter',
  'claims_yc_outbound_drafter',
  'claims_web_signal_drafter',
  'claims_icp_drafter_test',
];

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = await sb.from('workspaces').select('id').like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false }).limit(1).single();
  if (!ws.data) throw new Error('no workspace');
  const WS = ws.data.id as string;

  const subs = await sb.from('subscriptions').select('id, name, owner_id, active')
    .eq('workspace_id', WS).in('owner_id', LEGACY_DRAFTER_OWNERS);

  let deactivated = 0;
  for (const s of (subs.data ?? []) as Array<{ id: string; name: string; owner_id: string; active: boolean }>) {
    if (!s.active) { console.log(`  [skip] ${s.name} already off`); continue; }
    const upd = await sb.from('subscriptions').update({ active: false }).eq('id', s.id);
    if (upd.error) { console.log(`  [err]  ${s.name}: ${upd.error.message}`); continue; }
    console.log(`  [off]  ${s.name}`);
    deactivated++;
  }
  console.log(`\n${deactivated} drafter subscription(s) deactivated. outbound_drafter is the source of truth.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
