/**
 * Derive the live verdict rather than trusting the scorecard's prose: which
 * brief questions does `unreachableQuestions` actually rule out right now, what
 * would the planner be shown, and when was the strategy last regenerated.
 * Read-only.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { getPolicy, resolveBrief, loadQuestionSearchRecords, unreachableQuestions, questionsWorthSearching, earnsItsSearches, UNREACHABLE_WINDOW_DAYS, UNREACHABLE_PAGES, FAIR_TRIAL_PAGES, loadAngleRecords, failedAngles, orphanedAngles } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const policy: any = await getPolicy(sb, WS);
  console.log('strategy_generated_at:', policy.research?.strategy_generated_at, '| brief_generated_at:', policy.research?.brief_generated_at);
  console.log('UNREACHABLE_WINDOW_DAYS =', UNREACHABLE_WINDOW_DAYS, ' FAIR_TRIAL_PAGES =', FAIR_TRIAL_PAGES, ' UNREACHABLE_PAGES =', UNREACHABLE_PAGES);

  const records = await loadQuestionSearchRecords(sb, WS, UNREACHABLE_WINDOW_DAYS);
  console.log('\nQUESTION RECORDS (the window the live rule reads):');
  for (const r of records.sort((a: any, b: any) => b.fetched - a.fetched)) {
    const rr = r as any;
    console.log(`  ${String(rr.id).padEnd(24)} fetched=${String(rr.fetched).padStart(5)} kept=${String(rr.kept).padStart(4)}  earns=${earnsItsSearches(rr)}  unreachable=${rr.fetched >= UNREACHABLE_PAGES && !earnsItsSearches(rr)}`);
  }

  const dead = unreachableQuestions(records);
  console.log('\nunreachableQuestions() ->', dead.length ? dead.join(', ') : '(none)');
  console.log('questionsWorthSearching() -> ', questionsWorthSearching(policy, records).map((q: any) => q.id).join(', '));
  console.log('full brief             -> ', resolveBrief(policy).map((q: any) => q.id).join(', '));

  const stored = policy.research?.strategy ?? [];
  const angleRecs = await loadAngleRecords(sb, WS, stored);
  console.log('\nANGLE RECORDS:');
  for (const r of angleRecs as any[]) console.log(`  ${String(r.id).padEnd(30)} fetched=${String(r.fetched).padStart(5)} kept=${String(r.kept).padStart(4)}  earns=${earnsItsSearches(r)}`);
  console.log('\nfailedAngles()   ->', failedAngles(stored, angleRecs).join(', ') || '(none)');
  console.log('orphanedAngles() ->', orphanedAngles(policy).join(', ') || '(none)');
  console.log('\nangles whose question is already ruled unreachable:',
    stored.filter((a: any) => a.answers && dead.includes(a.answers)).map((a: any) => `${a.id} -> ${a.answers}`).join(', ') || '(none)');
}
main().catch((e) => { console.error(e); process.exit(1); });
