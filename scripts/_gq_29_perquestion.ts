/**
 * Does the runner actually write per_question_fetched, and does the record read
 * it back?
 *
 * The one piece of this that assertions cannot cover: the field has to survive
 * the runner, the activity marker, and the events row. Everything downstream —
 * whether a question's spend survives its search being rewritten, and therefore
 * whether the loop can ever conclude "no search answers this" — rests on it being
 * there.
 *
 * SPENDS EXA: 5 searches on one never-researched account (~$0.05).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPolicy, foldFetchedByQuestion } from '@agent-crm/tools';
import { runEntityResearch } from '../inngest/functions/research.ts';

const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

(async () => {
  const sb = createServerClient();
  const policy = await getPolicy(sb as any, WS);
  const angles = (policy.research?.strategy ?? []).filter((a) => a.enabled !== false);
  console.log('angles that will run:');
  for (const a of angles) console.log(`  ${a.id.padEnd(24)} answers=${a.answers ?? '(none)'}`);

  const researched = new Set<string>();
  for (const a of ['research_completed', 'research_triggered']) {
    const ev = (await sb.from('events').select('target_id').eq('workspace_id', WS).eq('action', a).limit(5000)).data ?? [];
    for (const e of ev as any[]) researched.add(e.target_id);
  }
  const fits = (await sb.from('facts').select('subject_entity, object_text')
    .eq('workspace_id', WS).eq('predicate', 'icp_fit').limit(2000)).data ?? [];
  const ranked = (fits as any[]).map((r) => ({ id: r.subject_entity, fit: Number(r.object_text) }))
    .filter((r) => Number.isFinite(r.fit) && !researched.has(r.id)).sort((a, b) => b.fit - a.fit);

  let target: { id: string; name: string } | null = null;
  for (const r of ranked) {
    const e = (await sb.from('entities').select('id, name, attributes').eq('id', r.id).maybeSingle()).data as any;
    if (e?.attributes?.domain) { target = { id: e.id, name: e.name }; break; }
  }
  if (!target) { console.log('no never-researched account with a domain — nothing to run'); return; }

  console.log(`\nrunning research on ${target.name} (5 searches)...`);
  const startedAt = new Date().toISOString();
  const r: any = await runEntityResearch(sb, {
    workspace_id: WS, entity_id: target.id, entity_name: target.name,
    reason: 'manual:_gq_29', angle_count: 5, kind: 'account',
  } as any);
  console.log(`  searches=${r.searches} kept=${r.signals_created}`);
  console.log(`  returned per_angle_fetched    = ${JSON.stringify(r.per_angle_fetched ?? {})}`);
  console.log(`  returned per_question_fetched = ${JSON.stringify(r.per_question_fetched ?? {})}`);

  // The stored row is what every reader actually sees.
  const ev = (await sb.from('events').select('payload, created_at')
    .eq('workspace_id', WS).eq('action', 'research_completed')
    .gte('created_at', startedAt).order('created_at', { ascending: false }).limit(1)).data ?? [];
  const stored = (ev[0] as any)?.payload ?? {};
  console.log(`\n  stored per_angle_fetched      = ${JSON.stringify(stored.per_angle_fetched ?? {})}`);
  console.log(`  stored per_question_fetched   = ${JSON.stringify(stored.per_question_fetched ?? {})}`);

  const sumAngle = Object.values(stored.per_angle_fetched ?? {}).reduce((n: number, v) => n + Number(v), 0);
  const sumQ = Object.values(stored.per_question_fetched ?? {}).reduce((n: number, v) => n + Number(v), 0);
  const unattributed = angles.filter((a) => !a.answers).map((a) => a.id);
  console.log(`\n  pages attributed to an angle:    ${sumAngle}`);
  console.log(`  pages attributed to a question:  ${sumQ}`);
  console.log(`  angles serving no question:      ${unattributed.length ? unattributed.join(', ') : 'none'}`);
  console.log(sumQ === sumAngle
    ? '  MATCH — every page bought is charged to the question it was bought for'
    : `  GAP of ${sumAngle - sumQ} page(s) — expected only from the angles listed above`);

  // And the fold reads it back rather than reconstructing through the angle.
  const folded = foldFetchedByQuestion(ev as any, angles, Date.now());
  console.log(`\n  folded (brief floor set to NOW, so reconstruction is impossible) = ${JSON.stringify(folded)}`);
  console.log(Object.keys(folded).length
    ? '  READ BACK — the question keeps this spend however its search is rewritten'
    : '  NOT READ BACK');
})();
