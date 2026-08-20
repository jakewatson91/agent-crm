/**
 * Assertions for the debounced rescore.
 *
 * The enricher no longer runs the ICP rubric itself. It asks rescoreEntity for a
 * rescore, and that function debounces on the account so a research burst that
 * writes 27 facts one article at a time costs one rubric call instead of 27.
 *
 * Two things can go wrong, and both fail silently in production, which is why
 * they are pinned here rather than left to review.
 *
 * 1. The dispatch fails and nobody scores. A local run under launchd has no
 *    working INNGEST_EVENT_KEY, so `send` throws there every time. If a throw
 *    were treated as "handed off", every account enriched by the local loop
 *    would keep its old score forever and nothing would report it.
 * 2. The debounce is keyed on the wrong field. Keyed on workspace_id, one busy
 *    account absorbs every other account's rescore request in that workspace,
 *    and the rest of the book silently stops being scored. It still looks like
 *    a working system: rescores happen, just not for the accounts that asked.
 */
import { requestRescore } from '../inngest/functions/agent_logic.ts';
import { RESCORE_DEBOUNCE } from '../inngest/functions/rescore_entity.ts';

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`}`);
  if (!ok) fail++;
}

const ARGS = { workspace_id: 'ws-1', entity_id: 'ent-1', reason: 'enricher_asserted_facts' };

(async () => {
  console.log('\nA dispatch that fails must send the caller back to scoring inline:');
  {
    const thrown = await requestRescore(() => { throw new Error('401 stale event key'); }, ARGS);
    eq('a synchronous throw is not a hand-off', thrown, false);
    const rejected = await requestRescore(() => Promise.reject(new Error('ECONNREFUSED')), ARGS);
    eq('a rejected promise is not a hand-off', rejected, false);
  }

  console.log('\nA dispatch that succeeds means the caller must NOT score inline:');
  {
    const sent: unknown[] = [];
    const ok = await requestRescore(async (a) => { sent.push(a); }, ARGS);
    eq('a resolved send is a hand-off', ok, true);
    eq('the request carries the account, not just the workspace', sent, [ARGS]);
  }

  console.log('\nThe debounce collapses one ACCOUNT\'s burst, never a whole workspace:');
  eq('keyed on the entity', RESCORE_DEBOUNCE.key, 'event.data.entity_id');
  // A period long enough to outlast the gaps inside a burst. Measured on Sudden:
  // 22 of 27 gaps between rubric calls on one account were under 5 minutes.
  eq('the quiet period is 10m', RESCORE_DEBOUNCE.period, '10m');
  // Without a timeout, a steady drip of facts extends the window indefinitely and
  // the score never lands at all.
  eq('extension is capped by a timeout', RESCORE_DEBOUNCE.timeout, '30m');
  eq('the cap is longer than the period', Number.parseInt(RESCORE_DEBOUNCE.timeout, 10) > Number.parseInt(RESCORE_DEBOUNCE.period, 10), true);

  console.log(fail === 0 ? '\nAll rescore-debounce assertions passed.\n' : `\n${fail} FAILED\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
