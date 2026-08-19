import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { buildThresholds, getPolicy, DEFAULT_ANCHOR_FRESH_DAYS } from '@agent-crm/tools';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const PAGE = 1000;
async function all<T>(q: (f: number, t: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += PAGE) {
    const { data, error } = await q(f, f + PAGE - 1);
    if (error) throw new Error(error.message);
    const p = (data ?? []) as T[]; out.push(...p);
    if (p.length < PAGE) break;
  }
  return out;
}
async function main() {
  const sb = createServerClient();
  const policy = await getPolicy(sb, WS);
  const T = buildThresholds(policy.routing, policy.drafter?.outreach_channel);
  const fresh = policy.drafter?.trigger_fresh_days ?? DEFAULT_ANCHOR_FRESH_DAYS;
  console.log(`freshness window: ${fresh}d  (policy.drafter.trigger_fresh_days = ${policy.drafter?.trigger_fresh_days ?? 'unset'})`);
  
  const scoreRows = await all<any>((f, t) => sb.from('facts').select('id, subject_entity, predicate, object_text, supersedes')
    .eq('workspace_id', WS).in('predicate', ['score_total','score_signal_strength','score_evidence_depth']).order('id').range(f, t));
  const pointed = new Set(scoreRows.map(r => r.supersedes).filter(Boolean));
  const byEnt = new Map<string, any>();
  for (const r of scoreRows) {
    if (pointed.has(r.id)) continue;
    const e = byEnt.get(r.subject_entity) ?? { tot: NaN, sig: NaN, ev: NaN };
    const v = parseFloat(r.object_text ?? '');
    if (r.predicate === 'score_total') e.tot = v;
    else if (r.predicate === 'score_signal_strength') e.sig = v;
    else e.ev = v;
    byEnt.set(r.subject_entity, e);
  }
  const scored = [...byEnt.entries()].filter(([, e]) => Number.isFinite(e.tot));
  
  const since = new Date(Date.now() - fresh * 86400_000).toISOString();
  const aRows = await all<any>((f, t) => sb.from('facts').select('subject_entity, id, supersedes')
    .eq('workspace_id', WS).not('happened_at', 'is', null).gte('happened_at', since).order('id').range(f, t));
  const aPointed = new Set(aRows.map(r => r.supersedes).filter(Boolean));
  const anchored = new Set(aRows.filter(r => !aPointed.has(r.id)).map(r => r.subject_entity));
  
  const old = scored.filter(([, e]) => e.tot >= T.DRAFT_ICP_TOTAL && e.sig >= T.DRAFT_SIGNAL_STRENGTH && e.ev >= T.DRAFT_EVIDENCE_DEPTH);
  const noGate = scored.filter(([, e]) => e.tot >= T.DRAFT_ICP_TOTAL && e.ev >= T.DRAFT_EVIDENCE_DEPTH);
  const now = scored.filter(([id, e]) => e.tot >= T.DRAFT_ICP_TOTAL && anchored.has(id) && e.ev >= T.DRAFT_EVIDENCE_DEPTH);
  
  console.log(`\nscored accounts:                              ${scored.length}`);
  console.log(`accounts holding a fresh dated event:         ${anchored.size}`);
  console.log(`\nclear the draft bars...`);
  console.log(`  BEFORE (fit + signal_strength + evidence):  ${old.length}`);
  console.log(`  IF signal_strength were just deleted:       ${noGate.length}   <- the failure mode the plan warned about`);
  console.log(`  NOW (fit + anchor + evidence):              ${now.length}`);
  const oldSet = new Set(old.map(([id]) => id));
  const nowSet = new Set(now.map(([id]) => id));
  console.log(`\n  newly reachable (anchor, no signal_strength): ${now.filter(([id]) => !oldSet.has(id)).length}`);
  console.log(`  no longer reachable (score but nothing happened): ${old.filter(([id]) => !nowSet.has(id)).length}`);
  
}
main().catch((e)=>{console.error(e);process.exit(1);});
