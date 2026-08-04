/**
 * Run the real research runner against named accounts, so a change to the
 * pipeline can be checked end-to-end on the accounts it was built for instead
 * of whatever happens to score highest today.
 *
 * Spends real Exa credit: ~5 searches per account. Creates real signals.
 *
 * Usage: tsx scripts/_run_research_named.ts "Weyyak" "Ab Films TV"
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { runEntityResearch } from '../inngest/functions/research.ts';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createServerClient();
  const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!names.length) { console.log('pass account names'); return; }
  for (const name of names) {
    const { data } = await sb.from('entities').select('id, name')
      .eq('workspace_id', WS).eq('name', name).maybeSingle();
    if (!data) { console.log(`${name}: NOT FOUND`); continue; }
    const e = data as { id: string; name: string };
    try {
      const r: any = await runEntityResearch(sb, {
        workspace_id: WS, entity_id: e.id, entity_name: e.name,
        reason: 'manual:_run_research_named', angle_count: 5, kind: 'account',
      } as any);
      console.log(`\n${e.name}:`);
      console.log(`  ${JSON.stringify(r)}`);
    } catch (err) {
      console.log(`${e.name}: ERROR ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
