/**
 * Verify the dispatcher fix: replay its score-loading block exactly as the
 * patched code does it, and confirm the values it now reads match the current
 * facts (i.e. what _gq_19_tierdrift.ts calls "actual").
 *
 * Read-only.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const IN_CHUNK = 200;
const HOT = 0.5, COLD = 0.3;
const tier = (s: number) => (s >= HOT ? 'hot' : s < COLD ? 'cold' : 'default');

async function chunkedInPaged<T>(ids: string[], run: (c: string[], f: number, t: number) => any): Promise<T[]> {
  const out: T[] = []; const PAGE = 1000;
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    let from = 0;
    for (;;) {
      const { data, error } = await run(chunk, from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data?.length) break;
      out.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }
  return out;
}

(async () => {
  const ents = (await sb.from('facts').select('subject_entity')
    .eq('workspace_id', WS).eq('predicate', 'is_a').eq('object_text', 'account').limit(5000)).data ?? [];
  const acctIds = [...new Set((ents as any[]).map((e) => e.subject_entity))].slice(0, 5000);
  console.log(`accounts: ${acctIds.length}`);

  // Exactly the patched dispatcher read.
  const raw = await chunkedInPaged<any>(acctIds, (chunk, from, to) => sb.from('facts')
    .select('id, subject_entity, predicate, object_text, observed_at, supersedes')
    .eq('workspace_id', WS).in('subject_entity', chunk)
    .in('predicate', ['icp_fit', 'score_total', 'score_signal_strength', 'dropped_until'])
    .order('id').range(from, to));
  console.log(`rows read (all versions, paged): ${raw.length}`);

  const supersededIds = new Set(raw.map((f) => f.supersedes).filter(Boolean));
  const latestByKey = new Map<string, any>();
  for (const f of raw) {
    if (supersededIds.has(f.id)) continue;
    const key = `${f.subject_entity}|${f.predicate}`;
    const prev = latestByKey.get(key);
    if (!prev || f.observed_at > prev.observed_at) latestByKey.set(key, f);
  }
  const dispatcherNow = new Map<string, number>();
  for (const f of latestByKey.values()) {
    if (f.predicate !== 'score_total') continue;
    const v = parseFloat(f.object_text ?? '');
    if (Number.isFinite(v)) dispatcherNow.set(f.subject_entity, v);
  }

  // Independent recompute of "current", same as _gq_19.
  const all = await chunkedInPaged<any>(acctIds, (chunk, from, to) => sb.from('facts')
    .select('id, subject_entity, object_text, observed_at, supersedes')
    .eq('workspace_id', WS).eq('predicate', 'score_total').in('subject_entity', chunk).order('id').range(from, to));
  const supAll = new Set(all.map((f) => f.supersedes).filter(Boolean));
  const truth = new Map<string, { v: number; at: string }>();
  for (const f of all) {
    if (supAll.has(f.id)) continue;
    const v = parseFloat(f.object_text ?? '');
    if (!Number.isFinite(v)) continue;
    const prev = truth.get(f.subject_entity);
    if (!prev || f.observed_at > prev.at) truth.set(f.subject_entity, { v, at: f.observed_at });
  }

  let match = 0, mismatch = 0, tierMismatch = 0, missing = 0;
  for (const [id, t] of truth) {
    const d = dispatcherNow.get(id);
    if (d === undefined) { missing++; continue; }
    if (Math.abs(d - t.v) < 1e-9) match++;
    else { mismatch++; if (tier(d) !== tier(t.v)) tierMismatch++; }
  }
  console.log(`\naccounts with a current score_total: ${truth.size}`);
  console.log(`  dispatcher now reads the CURRENT value : ${match}`);
  console.log(`  still differs                          : ${mismatch}`);
  console.log(`  still in the wrong tier                : ${tierMismatch}`);
  console.log(`  read no score at all (paging loss)     : ${missing}`);
  console.log(mismatch === 0 && missing === 0 ? '\nFIXED — dispatcher tiering now matches current scores exactly.' : '\nSTILL BROKEN');
})();
