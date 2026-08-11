/**
 * Two counters disagree about how many researched facts end up in a message.
 * research_scorecard.ts says 0. _cost_03_funnel.ts says 14. Find out which is
 * right before anything is tuned on the strength of either.
 *
 * They read the same table and count different things:
 *   scorecard  — cited facts grouped BY QUESTION, via the signal's
 *                structured_tags.answers_question. A fact whose page was never
 *                tagged with a question is invisible to it.
 *   funnel     — cited facts belonging to ANY research signal in the window.
 *
 * If that is the whole story, the gap is untagged pages, not missing citations,
 * and the scorecard is under-reporting rather than the funnel over-reporting.
 *
 * Reads only.
 *
 * Usage: pnpm tsx scripts/_cost_07_who_is_lying.ts [--days 30]
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

  // every draft and what it cited
  const chans = (await sb.from('channels').select('id').eq('workspace_id', WS).limit(5000)).data ?? [];
  const chanIds = (chans as Array<{ id: string }>).map((c) => c.id);
  let drafts: Array<{ cites: string[] | null; created_at: string }> = [];
  for (let i = 0; i < chanIds.length; i += 200) {
    const { data } = await sb.from('channel_posts').select('cites, created_at')
      .in('channel_id', chanIds.slice(i, i + 200)).eq('kind', 'touch_draft')
      .gte('created_at', since).limit(2000);
    drafts = drafts.concat((data ?? []) as any[]);
  }
  const citedIds = [...new Set(drafts.flatMap((d) => d.cites ?? []))];

  console.log(`\n${drafts.length} drafts, ${citedIds.length} distinct facts cited`);
  console.log(`drafts citing nothing at all: ${drafts.filter((d) => !(d.cites ?? []).length).length}`);

  // what each cited fact is, and where it came from
  const facts: any[] = [];
  for (let i = 0; i < citedIds.length; i += 200) {
    const { data } = await sb.from('facts').select('id, predicate, object_text, signal_id, observed_at')
      .in('id', citedIds.slice(i, i + 200)).limit(1000);
    facts.push(...(data ?? []));
  }
  const sigIds = [...new Set(facts.map((f) => f.signal_id).filter(Boolean))];
  const sigs = new Map<string, any>();
  for (let i = 0; i < sigIds.length; i += 200) {
    const { data } = await sb.from('signals').select('id, type, observed_at, structured_tags')
      .in('id', sigIds.slice(i, i + 200)).limit(1000);
    for (const s of (data ?? []) as any[]) sigs.set(s.id, s);
  }

  let noSignal = 0, researchTagged = 0, researchUntagged = 0, otherSignal = 0;
  const byPredicate = new Map<string, number>();
  for (const f of facts) {
    byPredicate.set(f.predicate, (byPredicate.get(f.predicate) ?? 0) + 1);
    if (!f.signal_id) { noSignal++; continue; }
    const s = sigs.get(f.signal_id);
    if (!s) { noSignal++; continue; }
    if (s.type !== 'research_result') { otherSignal++; continue; }
    if (s.structured_tags?.answers_question) researchTagged++;
    else researchUntagged++;
  }

  console.log(`\nwhere the cited facts came from:`);
  console.log(`  no signal at all (CSV import, enrichment, scoring)   ${noSignal}`);
  console.log(`  a research page TAGGED with a brief question         ${researchTagged}   <- the only ones the scorecard can see`);
  console.log(`  a research page with NO question tag                 ${researchUntagged}   <- invisible to the scorecard`);
  console.log(`  some other kind of signal                            ${otherSignal}`);

  console.log(`\nverdict:`);
  if (researchTagged === 0 && researchUntagged > 0) {
    console.log(`  The scorecard is RIGHT about what it measures and MISLEADING as a headline.`);
    console.log(`  ${researchUntagged} researched facts did reach a message, but every one came off a page`);
    console.log(`  that predates question tagging, so no question gets credit for it. "used = 0"`);
    console.log(`  means "no TAGGED page has been cited yet", not "research is worthless".`);
  } else if (researchTagged > 0) {
    console.log(`  Both are partly right: ${researchTagged} tagged + ${researchUntagged} untagged were cited.`);
  } else {
    console.log(`  No researched fact of any kind was cited. The funnel's 14 were something else.`);
  }

  console.log(`\nwhat drafts actually lean on, by predicate:`);
  for (const [p, n] of [...byPredicate.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${p.slice(0, 40).padEnd(42)}${n}`);
  }

  // How much of the corpus is even taggable? Tagging started with the brief.
  const allResearch = await pageAll<any>((f, t) => sb.from('signals')
    .select('id, structured_tags, observed_at').eq('workspace_id', WS)
    .eq('type', 'research_result').gte('observed_at', since).range(f, t));
  const tagged = allResearch.filter((s) => s.structured_tags?.answers_question).length;
  console.log(`\nresearch pages in the window: ${allResearch.length}, of which tagged with a question: ${tagged} (${((tagged / (allResearch.length || 1)) * 100).toFixed(0)}%)`);
  const oldestTagged = allResearch.filter((s) => s.structured_tags?.answers_question)
    .map((s) => s.observed_at).sort()[0];
  console.log(`oldest tagged page: ${oldestTagged ?? 'none'}`);
})();
