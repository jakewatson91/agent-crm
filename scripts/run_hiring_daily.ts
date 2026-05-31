/**
 * Dev / on-demand driver for the daily hiring loop. Finds every ACTIVE `ats`
 * source (across all workspaces, or one if WORKSPACE_ID is set) and runs its
 * connector synchronously, then writes a real last_run_summary — the same
 * fields sourceRun writes in prod, so the Sources view reflects the run.
 *
 * This is the manual equivalent of the Inngest daily cron (`0 13 * * *`). Use it
 * to drive end-to-end tests now; prod runs the same connector via sourceDispatcher.
 *
 *   pnpm hiring:run                 # all active ats sources
 *   WORKSPACE_ID=<uuid> pnpm hiring:run
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { getConnector } from '../inngest/functions/sources/registry.js';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

(async () => {
  let q = sb.from('sources')
    .select('id, workspace_id, connector_type, config, last_run_at')
    .eq('connector_type', 'ats')
    .eq('active', true);
  if (process.env.WORKSPACE_ID) q = q.eq('workspace_id', process.env.WORKSPACE_ID);
  const { data: sources, error } = await q;
  if (error) { console.error('load sources failed:', error.message); process.exit(1); }
  if (!sources?.length) { console.log('no active ats sources found.'); return; }

  console.log(`running ${sources.length} active ats source(s)...\n`);
  for (const source of sources) {
    const connector = getConnector(source.connector_type as string);
    if (!connector) { console.log(`  skip ${source.id.slice(0, 8)}: unknown connector`); continue; }
    const t0 = Date.now();
    const out = await connector.run({
      supabase: sb,
      workspace_id: source.workspace_id as string,
      source_id: source.id as string,
      config: (source.config ?? {}) as Record<string, unknown>,
      last_run_at: (source.last_run_at as string | null) ?? null,
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const status = out.errors.length === 0 ? 'ok' : 'error';
    await sb.from('sources').update({
      last_run_at: new Date().toISOString(),
      last_run_status: status,
      last_run_summary: {
        signals_created: out.signals_created,
        entities_created: out.entities_created,
        skipped: out.skipped,
        errors: out.errors.slice(0, 5),
      },
    }).eq('id', source.id);
    console.log(`  ${source.id.slice(0, 8)} [${status}] in ${dt}s — signals=${out.signals_created} skipped=${out.skipped} errors=${out.errors.length}`);
    for (const e of out.errors.slice(0, 8)) console.log(`      · ${e}`);
  }
  console.log('\ndone.');
})();
