/**
 * What the empty-run backoff would do to the Sudden book, measured, not guessed.
 *
 * Counts accounts by how many research passes in a row came back with nothing,
 * then works out how many of today's due accounts the new multiplier holds back
 * and what that is worth in Exa searches.
 *
 * Reads only. Usage: pnpm tsx scripts/_sim_empty_backoff.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import {
  entityIdsOfType, latestMarkerByEntity, countTrailingEmptyResearch, ACTIVITY_MARKERS,
  getPolicy, resolveTierCadenceHours, emptyRunBackoff, currentFactRows,
} from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const HOT_ICP = 0.5, HOT_SIG = 0.7, COLD_ICP = 0.3;

(async () => {
  const acctIds = (await entityIdsOfType(sb as any, WS, 'account')).slice(0, 5000);
  const policy = await getPolicy(sb as any, WS);
  const cadence = resolveTierCadenceHours(policy);
  const now = Date.now();

  const last = await latestMarkerByEntity(sb as any, WS, acctIds, [ACTIVITY_MARKERS.RESEARCH_TRIGGERED, ACTIVITY_MARKERS.RESEARCH_COMPLETED]);
  const empties = await countTrailingEmptyResearch(sb as any, WS, acctIds);

  // scores, same read shape as the dispatcher
  const raw: any[] = [];
  for (let i = 0; i < acctIds.length; i += 200) {
    const chunk = acctIds.slice(i, i + 200);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('facts').select('id, subject_entity, predicate, object_text, observed_at, supersedes')
        .eq('workspace_id', WS).in('subject_entity', chunk)
        .in('predicate', ['icp_fit', 'score_total', 'score_signal_strength']).order('id').range(from, from + 999);
      if (error) throw error;
      if (!data?.length) break;
      raw.push(...data); if (data.length < 1000) break;
    }
  }
  const cur = [...currentFactRows(raw as any, (f: any) => `${f.subject_entity}|${f.predicate}`).values()] as any[];
  const score = new Map<string, { total: number | null; sig: number | null }>();
  for (const f of cur) {
    const s = score.get(f.subject_entity) ?? { total: null, sig: null };
    const v = parseFloat(f.object_text ?? '');
    if (f.predicate === 'score_total' && Number.isFinite(v)) s.total = v;
    else if (f.predicate === 'icp_fit' && s.total === null && Number.isFinite(v)) s.total = v;
    else if (f.predicate === 'score_signal_strength' && Number.isFinite(v)) s.sig = v;
    score.set(f.subject_entity, s);
  }

  const dist = new Map<number, number>();
  for (const id of acctIds) dist.set(empties.get(id) ?? 0, (dist.get(empties.get(id) ?? 0) ?? 0) + 1);
  console.log('accounts by consecutive empty research runs (90d window):');
  for (const [k, v] of [...dist].sort((a, b) => a[0] - b[0])) console.log(`  ${k} empty: ${v}`);

  let dueBefore = 0, dueAfter = 0, heldBack = 0;
  const heldByTier = { hot: 0, default: 0, cold: 0 };
  for (const id of acctIds) {
    const lr = last.get(id) ?? 0;
    if (!lr) continue; // never researched: unaffected either way
    const s = score.get(id) ?? { total: null, sig: null };
    const tier: 'hot' | 'default' | 'cold' =
      (s.sig ?? 0) >= HOT_SIG || (s.total ?? 0) >= HOT_ICP ? 'hot' : (s.total ?? 0) >= COLD_ICP ? 'default' : 'cold';
    const sig = s.sig ?? 0;
    const signalBackoff = sig < 0.5 ? (sig < 0.3 ? 3 : 2) : 1;
    const emptyBackoff = emptyRunBackoff(empties.get(id) ?? 0, policy);
    const wasDue = now - lr >= cadence[tier] * signalBackoff * 3600e3;
    const isDue = now - lr >= cadence[tier] * Math.max(signalBackoff, emptyBackoff) * 3600e3;
    if (wasDue) dueBefore++;
    if (isDue) dueAfter++;
    if (wasDue && !isDue) { heldBack++; heldByTier[tier]++; }
  }
  console.log(`\ndue right now, before: ${dueBefore}   after: ${dueAfter}   held back: ${heldBack} (${dueBefore ? (100*heldBack/dueBefore).toFixed(0) : 0}%)`);
  console.log(`held back by tier: hot=${heldByTier.hot} default=${heldByTier.default} cold=${heldByTier.cold}`);
  console.log('\nheld-back accounts are the ones whose last 2+ passes each created nothing.');
})();
