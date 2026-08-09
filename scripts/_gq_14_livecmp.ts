/**
 * Compare research runs BEFORE and AFTER the brief, straight off the
 * research_completed markers. Splits at a cutover timestamp.
 *
 * Usage: pnpm tsx scripts/_gq_14_livecmp.ts "2026-08-09T16:00:00Z"
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const CUT = process.argv[2] ?? new Date(Date.now() - 3 * 3600 * 1000).toISOString();

interface Agg { runs: number; searches: number; kept: number; noAnswer: number; identity: number; unreported: number; stale: number; noName: number; unreadable: number; cls: Record<string, number>; q: Record<string, number> }
const mk = (): Agg => ({ runs: 0, searches: 0, kept: 0, noAnswer: 0, identity: 0, unreported: 0, stale: 0, noName: 0, unreadable: 0, cls: {}, q: {} });

(async () => {
  const ev = ((await sb.from('events').select('payload, created_at, target_id')
    .eq('workspace_id', WS).eq('action', 'research_completed')
    .gte('created_at', new Date(Date.parse(CUT) - 14 * 86400 * 1000).toISOString())
    .order('created_at', { ascending: false }).limit(3000)).data ?? []) as any[];

  const before = mk(), after = mk();
  for (const e of ev) {
    const d = e.payload ?? {};
    const a = Date.parse(e.created_at) >= Date.parse(CUT) ? after : before;
    a.runs++; a.searches += d.searches ?? 0; a.kept += d.results_created ?? 0;
    a.stale += d.filtered_stale ?? 0; a.noName += d.filtered_no_name ?? 0;
    a.unreadable += d.gate_unreadable ?? 0;
    const fb = d.filtered_by ?? {};
    a.noAnswer += fb.no_answer ?? 0;
    a.identity += fb.identity ?? 0;
    a.unreported += fb.unreported ?? 0;
    for (const [k, v] of Object.entries(d.per_class ?? {})) a.cls[k] = (a.cls[k] ?? 0) + (v as number);
    for (const [k, v] of Object.entries(d.per_question ?? {})) a.q[k] = (a.q[k] ?? 0) + (v as number);
  }

  const show = (label: string, a: Agg) => {
    const gateSaw = a.kept + a.noAnswer + a.identity + a.unreported;
    const unclass = a.cls.unclassified ?? 0;
    console.log(`\n--- ${label} — ${a.runs} runs, ${a.searches} searches ---`);
    console.log(`  pages reaching the gate : ${gateSaw}`);
    console.log(`  kept                    : ${a.kept}  (${gateSaw ? ((a.kept / gateSaw) * 100).toFixed(0) : '-'}% of what the gate saw)`);
    console.log(`  dropped no_answer       : ${a.noAnswer}`);
    console.log(`  dropped identity        : ${a.identity}`);
    console.log(`  dropped UNREPORTED      : ${a.unreported}   <- gate could not answer`);
    console.log(`  gate-unreadable batches : ${a.unreadable}`);
    console.log(`  pre-gate: stale=${a.stale} never-named-company=${a.noName}`);
    console.log(`  hook class of kept      : ${JSON.stringify(a.cls)}   unclassified=${a.kept ? ((unclass / a.kept) * 100).toFixed(0) : '-'}%`);
    if (Object.keys(a.q).length) console.log(`  kept per brief question : ${JSON.stringify(a.q)}`);
  };

  console.log(`cutover: ${CUT}`);
  show('BEFORE (old gate)', before);
  show('AFTER  (brief gate)', after);
})();
