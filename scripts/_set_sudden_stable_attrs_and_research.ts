/**
 * Two config writes for Sudden, both fixing things that were recorded as
 * "worth a look" rather than fixed.
 *
 * 1. `enrichment.stable_attributes` — the questions the out-of-scope veto keeps
 *    re-deriving from prose on every scoring call. OVI Technologies is the case:
 *    it calls itself a "sub second live streaming environment" and also carries
 *    an imported `product: Film/TV Streaming` tag, so the rubric had two facts
 *    with opposite answers, correctly refused to veto, and a live-only account
 *    sat at icp_fit 0.95. Storing the answer once removes the contradiction from
 *    the veto's path. Backfill with scripts/backfill_stable_attributes.ts.
 *
 *    The second attribute is the same shape and was already item 2 of the
 *    drafter plan: whether an account operates a streaming service or sells to
 *    the companies that do. Condition 2 of out_of_scope re-derives it every
 *    call, per account, forever.
 *
 * 2. `research.always_include` — peak concurrent audience. Jake confirmed the
 *    product needs viewers watching the same title at the same time, and that
 *    the floor below which the swarm does not form is UNKNOWN. That is not a
 *    veto condition (a binary test cannot fire on a book that holds no
 *    concurrency facts — the same mistake as the web-share condition deleted on
 *    2026-08-04). It is a number to go and collect first.
 *
 *    `always_include` alone is not enough: isStrategyFresh() checks only the age
 *    of `strategy_generated_at`, so a config edit sits inert until the strategy
 *    goes stale on its own. This forces the regeneration too.
 *
 * Usage: tsx scripts/_set_sudden_stable_attrs_and_research.ts [--apply]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { generateResearchStrategy, persistResearchStrategy } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const APPLY = process.argv.includes('--apply');

const STABLE_ATTRIBUTES = [
  {
    predicate: 'delivery_mode',
    question: 'Is the video this company serves to its own viewers live only, on demand only, or both? Live means sports, news, events or game streams watched as they happen. On demand means a catalog or replay library watched whenever the viewer chooses.',
    values: ['live_only', 'on_demand_only', 'both'],
  },
  {
    predicate: 'business_model',
    question: 'Does this company operate a streaming service watched by its own viewers, or does it sell video infrastructure, delivery, encoding or production services to the companies that do?',
    values: ['operates_streaming_service', 'sells_to_streaming_services', 'neither'],
  },
];

const ALWAYS_INCLUDE = [
  'Peak concurrent viewers or simultaneous streams on a single title, and any published number for the largest audience watching at once',
];

async function main() {
  const { data: w, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const policy = (w!.policy ?? {}) as Record<string, any>;

  console.log('=== enrichment.stable_attributes ===');
  console.log('BEFORE:', JSON.stringify(policy.enrichment?.stable_attributes ?? null));
  console.log('AFTER:');
  for (const a of STABLE_ATTRIBUTES) console.log(`  ${a.predicate}: ${a.values.join(' | ')}`);

  console.log('\n=== research.always_include ===');
  console.log('BEFORE:', JSON.stringify(policy.research?.always_include ?? null));
  console.log('AFTER:');
  for (const s of ALWAYS_INCLUDE) console.log(`  - ${s}`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write (the strategy regeneration costs one planner call).');
    return;
  }

  policy.enrichment = { ...(policy.enrichment ?? {}), stable_attributes: STABLE_ATTRIBUTES };
  policy.research = { ...(policy.research ?? {}), always_include: ALWAYS_INCLUDE };
  const { error: upErr } = await sb.from('workspaces').update({ policy }).eq('id', WS);
  if (upErr) throw upErr;
  console.log('\nConfig written.');

  // Force the strategy to be re-planned now. Without this the new must-include
  // term does not reach a single search until the cached strategy ages out.
  console.log('Regenerating research angles so always_include actually applies...');
  const { angles } = await generateResearchStrategy(sb as any, WS);
  await persistResearchStrategy(sb as any, WS, angles);
  for (const a of angles) {
    console.log(`  [${a.enabled === false ? 'off' : 'on '}] ${a.id} (${a.domain_scope}, ${a.recency_days ?? 'no date filter'}d)`);
    console.log(`        ${a.query_template}`);
  }
  console.log('\nNext: tsx scripts/backfill_stable_attributes.ts --limit 25   (dry run first)');
}
main().catch((e) => { console.error(e); process.exit(1); });
