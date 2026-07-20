/**
 * Live test for the pause-transition email (throwaway `test` workspace).
 *   1. capture current policy.pipeline
 *   2. force state ok (direct write, no side effects)
 *   3. setPipelineStatus paused  -> expect "[pipeline] pause alert: emailed ..."
 *   4. setPipelineStatus paused  -> expect NO alert line (edge not crossed)
 *   5. restore the captured pipeline value exactly
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { setPipelineStatus, type WorkspacePolicy } from '@agent-crm/tools';

const WS = 'ec837330-0000-0000-0000-000000000000'.slice(0, 8); // resolved below by prefix

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const wss = await sb.from('workspaces').select('id, name, policy');
  const ws = (wss.data ?? []).find((w) => (w.id as string).startsWith('ec837330'));
  if (!ws) throw new Error('test workspace not found');
  const prior = (ws.policy as WorkspacePolicy | null)?.pipeline;
  console.log(`workspace: ${ws.name} (${ws.id})`);
  console.log('prior pipeline:', JSON.stringify(prior ?? null));

  const raw = (ws.policy ?? {}) as Record<string, unknown>;
  await sb.from('workspaces').update({ policy: { ...raw, pipeline: { state: 'ok' } } }).eq('id', ws.id);
  console.log('\n--- write 1: paused (expect alert line) ---');
  await setPipelineStatus(sb, ws.id as string, {
    state: 'paused',
    scope: 'all',
    provider: 'test',
    reason: 'Test alert: verifying pause emails end-to-end. Nothing is actually paused. Ignore.',
    paused_at: new Date().toISOString(),
  });
  console.log('--- write 2: paused again (expect NO alert line) ---');
  await setPipelineStatus(sb, ws.id as string, {
    state: 'paused',
    scope: 'all',
    provider: 'test',
    reason: 'Test alert: second write, should not email.',
    paused_at: new Date().toISOString(),
  });

  const cur = await sb.from('workspaces').select('policy').eq('id', ws.id).maybeSingle();
  const curRaw = (cur.data?.policy ?? {}) as Record<string, unknown>;
  if (prior === undefined) delete curRaw.pipeline; else curRaw.pipeline = prior;
  await sb.from('workspaces').update({ policy: curRaw }).eq('id', ws.id);
  const after = await sb.from('workspaces').select('policy').eq('id', ws.id).maybeSingle();
  console.log('\nrestored pipeline:', JSON.stringify((after.data?.policy as WorkspacePolicy | null)?.pipeline ?? null));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
