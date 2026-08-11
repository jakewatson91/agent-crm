/**
 * 20 drafts in 30 days from a 2,243-account book. Where does everything else go?
 *
 * The earlier read — "facts are not reaching messages" — was wrong. 14 of the 35
 * facts those 20 drafts cite came from research, so research IS earning its
 * place. The bottleneck is upstream: how few accounts ever reach the drafter at
 * all, and what stops them.
 *
 * Reads only. Pages every query — the events table blows past PostgREST's
 * 1000-row cap in a single day here, and an unpaged read silently reports the
 * first 1000 rows as if they were the whole month.
 *
 * Usage: pnpm tsx scripts/_cost_08_why_so_few_drafts.ts [--days 30]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const argv = process.argv.slice(2);
let DAYS = 30;
for (let i = 0; i < argv.length; i++) if (argv[i] === '--days') DAYS = Number(argv[++i]) || DAYS;

async function pageAll<T>(build: (f: number, t: number) => any): Promise<T[]> {
  let out: T[] = []; let f = 0;
  for (;;) {
    const { data, error } = await build(f, f + 999);
    if (error) throw error;
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
    f += 1000;
  }
  return out;
}

(async () => {
  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();

  const ev = await pageAll<any>((f, t) => sb.from('events').select('action, payload, target_id')
    .eq('workspace_id', WS).gte('created_at', since).range(f, t));
  const byAction = new Map<string, number>();
  for (const e of ev) byAction.set(e.action, (byAction.get(e.action) ?? 0) + 1);

  console.log(`\n${ev.length.toLocaleString()} events in ${DAYS} days\n`);
  console.log('what the system spent its time on:');
  for (const [a, n] of [...byAction.entries()].sort((x, y) => y[1] - x[1]).slice(0, 18)) {
    console.log(`  ${String(n).padStart(7)}  ${a}`);
  }

  // Why the action selector skipped an account — this is the real gate on volume.
  const skips = ev.filter((e) => e.action === 'action_selector_skip');
  const skipReasons = new Map<string, number>();
  for (const s of skips) {
    const p = s.payload ?? {};
    const r = p.reason ?? p.skip_reason ?? p.why ?? 'unstated';
    skipReasons.set(r, (skipReasons.get(r) ?? 0) + 1);
  }
  console.log(`\nwhy accounts were skipped before any drafting (${skips.length} skips):`);
  for (const [r, n] of [...skipReasons.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15)) {
    console.log(`  ${String(n).padStart(7)}  ${r}`);
  }
  if (skips.length && skipReasons.size === 1 && skipReasons.has('unstated')) {
    console.log(`  (payload carries no reason field — sample: ${JSON.stringify(skips[0].payload).slice(0, 300)})`);
  }

  // What the dispatcher decided to do.
  const dispatch = ev.filter((e) => e.action === 'agent_dispatch_result');
  const dispatchOutcome = new Map<string, number>();
  for (const d of dispatch) {
    const p = d.payload ?? {};
    const k = p.action ?? p.decision ?? p.outcome ?? 'unstated';
    dispatchOutcome.set(k, (dispatchOutcome.get(k) ?? 0) + 1);
  }
  console.log(`\nwhat the agent decided to do when it did look (${dispatch.length} dispatches):`);
  for (const [k, n] of [...dispatchOutcome.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15)) {
    console.log(`  ${String(n).padStart(7)}  ${k}`);
  }
  if (dispatch.length && dispatchOutcome.size === 1 && dispatchOutcome.has('unstated')) {
    console.log(`  (sample payload: ${JSON.stringify(dispatch[0].payload).slice(0, 400)})`);
  }

  const distinctTouched = new Set(dispatch.map((d) => d.target_id).filter(Boolean));
  const total = (await sb.from('entities').select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS).is('archived_at', null)).count ?? 0;
  console.log(`\ndistinct accounts the agent looked at: ${distinctTouched.size} of ${total} (${((distinctTouched.size / (total || 1)) * 100).toFixed(1)}%)`);
})();
