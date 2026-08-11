/**
 * Would the new "no search answers this" verdict fire on live data, and is the
 * denominator it fires on trustworthy?
 *
 * The verdict compares pages bought for a question against pages kept for it. The
 * two numbers have to start from the same moment. `kept` is stamped on the signal
 * with the question id live at gate time; `fetched`, until the runner started
 * writing per_question_fetched, was reconstructed by summing the run markers of
 * whichever angles serve the question NOW. If the brief was regenerated inside
 * the window, an angle can have been buying pages for a question that did not yet
 * exist — inflating the denominator against a numerator that started later, which
 * is exactly how a good question gets condemned.
 *
 * Read-only. Spends nothing.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { getPolicy, resolveBrief, loadQuestionSearchRecords, unreachableQuestions, earnsItsSearches, questionsWorthSearching, UNREACHABLE_PAGES } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

(async () => {
  const policy = await getPolicy(sb as any, WS);
  console.log(`brief generated ${policy.research?.brief_generated_at ?? '(never)'}`);
  console.log(`strategy generated ${policy.research?.strategy_generated_at ?? '(never)'}\n`);

  console.log('angles in place:');
  for (const a of policy.research?.strategy ?? []) {
    console.log(`  ${a.id.padEnd(28)} answers=${(a.answers ?? '-').padEnd(20)} since=${a.record_since?.slice(0, 10) ?? '-'}  [${a.domain_scope}]`);
  }

  // When did each question id first appear on a signal? That is the earliest
  // moment a page could have been counted as answering it.
  const firstSeen: Record<string, string> = {};
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from('signals').select('structured_tags, observed_at')
      .eq('workspace_id', WS).eq('type', 'research_result')
      .order('observed_at', { ascending: true }).range(from, from + 999);
    for (const s of (data ?? []) as any[]) {
      const q = s.structured_tags?.answers_question;
      if (q && !firstSeen[q]) firstSeen[q] = s.observed_at;
    }
    if (!data || data.length < 1000) break;
  }

  const records = await loadQuestionSearchRecords(sb as any, WS);
  const unreachable = new Set(unreachableQuestions(records));
  const live = new Set(resolveBrief(policy).map((q) => q.id));

  console.log('\nquestion                     fetched  kept  earns?  first answered  verdict');
  console.log('-'.repeat(100));
  for (const r of records.sort((a, b) => b.fetched - a.fetched)) {
    const verdict = unreachable.has(r.id) ? 'NO SEARCH ANSWERS THIS'
      : r.fetched < UNREACHABLE_PAGES ? '' : 'ok';
    console.log(
      r.id.slice(0, 27).padEnd(29) + String(r.fetched).padStart(7) + String(r.kept).padStart(6) +
      (earnsItsSearches(r) ? '   yes' : '    no') + '  ' + (firstSeen[r.id]?.slice(0, 10) ?? '(never)').padStart(14) +
      '  ' + verdict + (live.has(r.id) ? '' : '   (not in the brief)'),
    );
  }

  // The same call loadContext makes, so this is the real decision and not a
  // second copy of it.
  const shown = new Set(questionsWorthSearching(policy, records).map((q) => q.id));
  console.log('\nwhat the strategy planner would be shown next regeneration:');
  for (const q of resolveBrief(policy)) {
    const why = shown.has(q.id) ? '' : q.id === 'pain' ? 'always noticed, never searched for' : 'RULED UNSEARCHABLE';
    console.log(`  ${why ? 'withheld' : 'shown   '}  ${q.id.padEnd(24)} ${why}`);
  }
})();
