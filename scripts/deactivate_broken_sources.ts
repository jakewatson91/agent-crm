/**
 * Deactivate sources that error every run because of config issues. Idempotent.
 * Reversible: set active=true to re-enable.
 *
 * Targets sources whose last_run_summary.errors mentions watch_entities is empty
 * (HN connector + lenny's web source set to intent=watch with no targets).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

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

  const errored = await sb.from('sources')
    .select('id, name, connector_type, last_run_summary, active')
    .eq('workspace_id', WS)
    .eq('last_run_status', 'error')
    .eq('active', true);

  const rows = (errored.data ?? []) as Array<{
    id: string;
    name: string;
    connector_type: string;
    last_run_summary: { errors?: string[] } | null;
  }>;

  let deactivated = 0;
  for (const s of rows) {
    const errs = (s.last_run_summary?.errors ?? []).join(' ');
    const isConfigError = /watch_entities is empty|requires watch_entities|nothing to match against/i.test(errs);
    if (!isConfigError) continue;
    const upd = await sb.from('sources').update({ active: false }).eq('id', s.id);
    if (upd.error) {
      console.log(`  [err]  ${s.name}: ${upd.error.message}`);
    } else {
      console.log(`  [off]  ${s.connector_type.padEnd(8)} ${s.name}`);
      deactivated++;
    }
  }
  console.log(`\n${deactivated} source(s) deactivated.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
