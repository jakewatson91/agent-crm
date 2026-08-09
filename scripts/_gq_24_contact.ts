/**
 * Small live check of the CONTACT research path.
 *
 * The page filter is shared with account research, but a contact pull hands it
 * the PERSON's name under a prompt header that reads "TARGET COMPANY", and
 * judges the results against questions written about companies. This runs one
 * search per contact and prints every verdict so the failure mode, if any, is
 * visible rather than inferred.
 *
 * SPENDS EXA: 1 search per contact.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { runEntityResearch } from '../inngest/functions/research.ts';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const NAMES = process.argv.slice(2).filter((a) => !a.startsWith('--'));

(async () => {
  const sb = createServerClient();
  for (const name of NAMES) {
    const e = (await sb.from('entities').select('id, name').eq('workspace_id', WS).eq('name', name).maybeSingle()).data as any;
    if (!e) { console.log(`${name}: NOT FOUND`); continue; }
    const before = new Date().toISOString();
    const r: any = await runEntityResearch(sb, {
      workspace_id: WS, entity_id: e.id, entity_name: e.name,
      reason: 'manual:_gq_24_contact', angle_count: 1, kind: 'contact',
    } as any);
    console.log(`\n=== ${e.name} ===`);
    console.log(`  ${JSON.stringify({ ok: r.ok, reason: r.reason, searches: r.searches, kept: r.signals_created, dropped: r.filtered_by, no_name: r.filtered_no_name, stale: r.filtered_stale, by_q: r.per_question })}`);
    const sigs = (await sb.from('signals').select('structured_tags').eq('workspace_id', WS)
      .eq('entity_id', e.id).gte('created_at', before).limit(20)).data ?? [];
    for (const s of sigs as any[]) {
      console.log(`   KEPT  q=${String(s.structured_tags?.answers_question ?? '-').padEnd(20)} class=${String(s.structured_tags?.hook_class ?? '-').padEnd(10)} ${String(s.structured_tags?.url).slice(0, 78)}`);
    }
  }
})();
