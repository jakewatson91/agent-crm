/**
 * Run the research RUNNER directly against the top-scoring researchable
 * accounts, right now.
 *
 * Why not _trigger_research_sudden.ts: the dispatcher emits `research.requested`
 * through Inngest, and a local run has no event key, so every send fails
 * (dispatch_errors = N, dispatched = 0). This calls the same core the runner
 * invokes once the event lands, so it works from a laptop.
 *
 * Spends real Exa credit: one search per strategy angle per account.
 *
 * Usage: tsx scripts/_run_research_now.ts [count]   (default 6, dry list first)
 *        tsx scripts/_run_research_now.ts 6 --apply
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { fetchAll } from '@agent-crm/tools';
import { runEntityResearch } from '../inngest/functions/research.ts';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const APPLY = process.argv.includes('--apply');
const N = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 6);

async function main() {
  const sb = createServerClient();
  const scores = await fetchAll<{ id: string; subject_entity: string; object_text: string | null; supersedes: string | null }>(
    (from, to) => sb.from('facts').select('id, subject_entity, object_text, supersedes')
      .eq('workspace_id', WS).eq('predicate', 'score_total').order('id').range(from, to));
  const sup = new Set(scores.map((r) => r.supersedes).filter(Boolean) as string[]);
  const ranked = scores.filter((r) => !sup.has(r.id))
    .map((r) => ({ id: r.subject_entity, s: parseFloat(r.object_text ?? '') }))
    .filter((r) => Number.isFinite(r.s)).sort((a, b) => b.s - a.s);

  const picked: Array<{ id: string; name: string; s: number }> = [];
  for (const r of ranked) {
    if (picked.length >= N) break;
    const { data: e } = await sb.from('entities').select('name, attributes, archived_at').eq('id', r.id).maybeSingle();
    const ent = e as any;
    if (!ent || ent.archived_at) continue;
    if (!ent.attributes?.domain) continue; // no domain, no own-site angle
    picked.push({ id: r.id, name: ent.name, s: r.s });
  }
  console.log(`top ${picked.length} researchable accounts by score:`);
  for (const p of picked) console.log(`  ${p.s.toFixed(2)}  ${p.name}`);
  if (!APPLY) { console.log('\nDry run. Re-run with --apply to spend the searches.'); return; }

  for (const p of picked) {
    try {
      const r: any = await runEntityResearch(sb, {
        workspace_id: WS, entity_id: p.id, entity_name: p.name,
        reason: 'manual:_run_research_now', angle_count: 5, kind: 'account',
      } as any);
      console.log(`  ${p.name}: ${r?.summary ?? JSON.stringify(r)}`);
    } catch (e) {
      console.log(`  ${p.name}: ERROR ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
