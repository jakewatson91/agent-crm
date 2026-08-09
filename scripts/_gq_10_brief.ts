/**
 * Generate the research brief for a workspace. DRY RUN by default — prints the
 * questions and writes nothing. Pass --apply to persist onto policy.research.brief.
 *
 * Usage: pnpm tsx scripts/_gq_10_brief.ts [--apply] [--ws <id>]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { generateResearchBrief, persistResearchBrief, briefInputHashFor, resolveBrief, getPolicy } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');
const wsArg = process.argv.indexOf('--ws');
const WS = wsArg > -1 ? process.argv[wsArg + 1]! : (process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3');

(async () => {
  const w = (await sb.from('workspaces').select('name, about').eq('id', WS).maybeSingle()).data as any;
  console.log(`WORKSPACE: ${w?.name}\nABOUT: ${(w?.about ?? '').slice(0, 400).replace(/\n/g, ' ')}\n`);

  const policy = await getPolicy(sb as any, WS);
  const existing = policy.research?.brief ?? [];
  if (existing.length) {
    console.log(`--- brief already stored (${policy.research?.brief_generated_at}) ---`);
    for (const q of resolveBrief(policy)) console.log(`  [${q.id}] ${q.question}`);
    console.log('');
  }

  const { questions, source, error } = await generateResearchBrief(sb as any, WS);
  console.log(`--- generated brief (source=${source}${error ? `, error=${error}` : ''}) ---`);
  for (const q of questions) {
    console.log(`\n  [${q.id}]  (${q.kind})  ${q.label}`);
    console.log(`     Q: ${q.question}`);
    if (q.why) console.log(`     why: ${q.why}`);
  }
  console.log(`\n${questions.length} questions. Predicate namespaces: ${questions.map((q) => `${q.id}.*`).join(', ')}, pain.*`);

  // Persist the questions THIS run printed. Generating once for the dry run and
  // again for --apply means the operator approves one brief and stores another,
  // and since a question id is a permanent predicate namespace that is not a
  // cosmetic difference.
  if (APPLY) {
    await persistResearchBrief(sb as any, WS, questions, await briefInputHashFor(sb as any, WS));
    console.log('\nPERSISTED to policy.research.brief');
  } else {
    console.log('\n(dry run — nothing written. --apply to persist)');
  }
})();
