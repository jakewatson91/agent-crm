/**
 * Step 4: is the relevance gate actually running? Reads the research_completed
 * markers (filtered_by buckets, per_class) plus the workspace's relevance config.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const DAYS = Number(process.argv[2] ?? 7);

(async () => {
  const w = (await sb.from('workspaces').select('name, about, icp, policy').eq('id', WS).maybeSingle()).data as any;
  const p = w.policy ?? {};
  console.log(`WORKSPACE: ${w.name}`);
  console.log('ICP signal_type:', JSON.stringify(w.icp?.signal_type ?? null));
  console.log('drafter.pain_points:', JSON.stringify(p.drafter?.pain_points ?? null, null, 1));
  console.log('research.guidance:', JSON.stringify((p.research?.guidance ?? '').slice(0, 400)));
  console.log('research.always_include:', JSON.stringify(p.research?.always_include ?? null));
  console.log('research.max_age_days:', p.research?.max_age_days, ' exclude_domains:', JSON.stringify(p.research?.exclude_domains ?? null));
  console.log('research.social_domains:', JSON.stringify(p.research?.social_domains ?? null));
  console.log('\nSTRATEGY (cached angles), generated', p.research?.strategy_generated_at);
  for (const a of p.research?.strategy ?? []) {
    console.log(`  ${String(a.id).padEnd(20)} ${String(a.domain_scope).padEnd(10)} ${String(a.recency_days ?? 'none').padStart(4)}d n=${a.num_results}  ${a.query_template}`);
  }

  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
  const ev = (await sb.from('events').select('action, payload, created_at')
    .eq('workspace_id', WS).eq('action', 'research_completed')
    .gte('created_at', since).order('created_at', { ascending: false }).limit(2000)).data ?? [];
  const marks = ev as any[];
  const tot = { searches: 0, created: 0, filtered_out: 0, stale: 0, no_name: 0, same_url: 0, dupes: 0 };
  const by = { identity: 0, substance: 0, relevance: 0, unreported: 0 } as Record<string, number>;
  const cls: Record<string, number> = {};
  const angle: Record<string, number> = {};
  for (const m of marks as any[]) {
    const d = m.payload ?? {};
    tot.searches += d.searches ?? 0; tot.created += d.results_created ?? 0;
    tot.filtered_out += d.filtered_out ?? 0; tot.stale += d.filtered_stale ?? 0;
    tot.no_name += d.filtered_no_name ?? 0; tot.same_url += d.same_url_dropped ?? 0; tot.dupes += d.duplicates_dropped ?? 0;
    for (const k of Object.keys(by)) by[k] += d.filtered_by?.[k] ?? 0;
    for (const [k, v] of Object.entries(d.per_class ?? {})) cls[k] = (cls[k] ?? 0) + (v as number);
    for (const [k, v] of Object.entries(d.per_angle ?? {})) angle[k] = (angle[k] ?? 0) + (v as number);
  }
  console.log(`\n=== research_completed markers last ${DAYS}d: ${marks.length} runs ===`);
  console.log(JSON.stringify(tot, null, 1));
  console.log('filtered_by:', JSON.stringify(by));
  console.log('per_class:', JSON.stringify(cls));
  console.log('per_angle:', JSON.stringify(angle));
  const errs = ((await sb.from('events').select('payload, created_at').eq('workspace_id', WS).eq('action', 'research_error').gte('created_at', since).limit(50)).data ?? []) as any[];
  console.log(`research_error markers: ${errs.length}`);
  for (const e of errs.slice(0, 5)) console.log('  ', JSON.stringify(e.payload).slice(0, 200));
})();
