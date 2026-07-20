import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { advanceAccounts } from '../inngest/functions/advance_accounts.js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function hunterCredits(): Promise<{used?: number; available?: number; raw: any}> {
  const key = process.env.HUNTER_API_KEY!;
  const res = await fetch(`https://api.hunter.io/v2/account?api_key=${key}`);
  const j: any = await res.json();
  const d = j?.data ?? {};
  const s = d.requests?.searches ?? d.calls ?? {};
  return { used: s.used, available: s.available, raw: { plan: d.plan_name, reset: d.reset_date, searches: d.requests?.searches, calls: d.calls } };
}

async function main() {
  const ws = ((await sb.from('workspaces').select('id, policy')).data ?? []).find((w: any) => (w.id as string).startsWith('af602fa1'))!;
  // Test config: Hunter as the ONLY provider so Explorium's empty balance can't
  // halt the run before Hunter runs. Clear the stale Explorium pause.
  const p: any = { ...(ws.policy ?? {}) };
  p.enrichment = { ...(p.enrichment ?? {}), contact_provider: 'hunter', contact_provider_fallback: 'none' };
  delete p.pipeline;
  const up = await sb.from('workspaces').update({ policy: p }).eq('id', ws.id);
  if (up.error) throw up.error;
  console.log('config -> contact_provider=hunter, fallback=none, pause cleared');

  const before = await hunterCredits();
  console.log('HUNTER BEFORE:', JSON.stringify(before));

  console.log(new Date().toISOString(), 'HUNTER TEST START (contactCap=15)');
  const r = await advanceAccounts(sb, { workspace_id: ws.id as string, contactCap: 15, draftCap: 15, maxAccounts: 300, onEvent: (l) => console.log(l) });
  console.log(new Date().toISOString(), 'RESULT', JSON.stringify(r));

  const after = await hunterCredits();
  console.log('HUNTER AFTER:', JSON.stringify(after));
  if (typeof before.used === 'number' && typeof after.used === 'number') {
    console.log(`CREDITS SPENT THIS RUN: ${after.used - before.used}  |  REMAINING: ${after.available}`);
  }
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
