/**
 * The money funnel: dollars in at the top, outcomes at the bottom.
 *
 * Cost per month is only half an argument. The other half is what the money
 * buys, and the buyer's unit is not a token or a search — it is a message worth
 * sending. This walks searches -> pages fetched -> pages kept -> facts -> facts a
 * draft actually cited -> drafts -> approvals, and puts the Exa+LLM cost against
 * each step.
 *
 * Reads only.
 *
 * Usage: pnpm tsx scripts/_cost_03_funnel.ts [--days 30] [--ws <id>]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_PRICING } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const argv = process.argv.slice(2);
let WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
let DAYS = 30;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--ws') WS = argv[++i] ?? WS;
  else if (argv[i] === '--days') DAYS = Number(argv[++i]) || DAYS;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

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

  const research = await pageAll<any>((f, t) => sb.from('events').select('payload')
    .eq('workspace_id', WS).eq('action', 'research_completed').gte('created_at', since).range(f, t));
  const metrics = await pageAll<any>((f, t) => sb.from('events').select('payload')
    .eq('workspace_id', WS).eq('action', 'agent_run_metrics').gte('created_at', since).range(f, t));

  let searches = 0, fetched = 0, kept = 0;
  for (const e of research) {
    const p = e.payload ?? {};
    searches += p.searches ?? 0;
    fetched += Object.values(p.per_angle_fetched ?? {}).reduce((n: number, v) => n + (Number(v) || 0), 0);
    kept += p.results_created ?? p.signals_created ?? 0;
  }

  let llmCost = 0;
  for (const e of metrics) {
    const p = e.payload ?? {};
    const price = (DEFAULT_PRICING.models as Record<string, { input: number; cached: number; output: number }>)[p.model ?? ''];
    if (!price) continue;
    const i = p.input_tokens ?? 0, o = p.output_tokens ?? 0, c = p.cached_input_tokens ?? 0;
    llmCost += ((i - c) / 1e6) * price.input + (c / 1e6) * price.cached + (o / 1e6) * price.output;
  }
  const exaCost = searches * DEFAULT_PRICING.exa_per_search;
  const total = llmCost + exaCost;

  // facts off research pages in the window
  const sigs = await pageAll<any>((f, t) => sb.from('signals').select('id')
    .eq('workspace_id', WS).eq('type', 'research_result').gte('observed_at', since).range(f, t));
  const sigIds = sigs.map((s) => s.id);
  let researchFacts = 0;
  const factIds = new Set<string>();
  for (let i = 0; i < sigIds.length; i += 200) {
    const { data } = await sb.from('facts').select('id').in('signal_id', sigIds.slice(i, i + 200)).limit(3000);
    for (const f of (data ?? []) as Array<{ id: string }>) { researchFacts++; factIds.add(f.id); }
  }

  // drafts + what they cited
  const chans = (await sb.from('channels').select('id').eq('workspace_id', WS).limit(5000)).data ?? [];
  const chanIds = (chans as Array<{ id: string }>).map((c) => c.id);
  let drafts = 0; const citedAll = new Set<string>();
  for (let i = 0; i < chanIds.length; i += 200) {
    const { data } = await sb.from('channel_posts').select('cites, kind')
      .in('channel_id', chanIds.slice(i, i + 200)).eq('kind', 'touch_draft').gte('created_at', since).limit(2000);
    for (const p of (data ?? []) as Array<{ cites: string[] | null }>) {
      drafts++;
      for (const c of p.cites ?? []) citedAll.add(c);
    }
  }
  const citedResearch = [...citedAll].filter((id) => factIds.has(id)).length;

  const line = (label: string, n: number, note = '') =>
    console.log(`  ${label.padEnd(34)}${String(n).padStart(8)}   ${note}`);

  console.log(`\nlast ${DAYS} days — total spend ${usd(total)}  (Exa ${usd(exaCost)}, LLM ${usd(llmCost)})\n`);
  console.log('the funnel:');
  line('Exa searches', searches, `${usd(exaCost / (searches || 1))} each`);
  line('pages fetched', fetched, `${usd(exaCost / (fetched || 1))} each`);
  line('pages kept by the gate', kept, `${usd(total / (kept || 1))} each, ${((kept / (fetched || 1)) * 100).toFixed(0)}% of fetched`);
  line('facts read off them', researchFacts, `${usd(total / (researchFacts || 1))} each`);
  line('drafts written', drafts, drafts ? `${usd(total / drafts)} each` : '');
  line('of those facts, cited in a draft', citedResearch,
    citedResearch ? `${((citedResearch / (researchFacts || 1)) * 100).toFixed(1)}% of research facts` : 'NOTHING RESEARCH BOUGHT REACHED A MESSAGE');
  line('total citations in drafts', citedAll.size, 'includes facts from CSV/other sources');

  console.log('\nwhat a buyer would ask:');
  if (drafts) console.log(`  cost per draft written        ${usd(total / drafts)}`);
  if (citedResearch) console.log(`  cost per research fact used   ${usd(total / citedResearch)}`);
  else console.log(`  cost per research fact used   n/a — zero research facts were cited, so the ${usd(exaCost)} of Exa bought nothing a message used`);
})();
