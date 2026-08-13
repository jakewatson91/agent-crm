/**
 * Assertions for the transport retry in the ATS job-board fetchers.
 *
 * The bug this pins: every fetcher called fetch() once under a 10s
 * AbortSignal.timeout. One slow response threw, the dispatcher recorded a
 * source error and moved on, and the board was not tried again until the next
 * run — where it could time out again. Sudden's only source sat in `error` for
 * 19.5h on `CrunchyRoll fetch greenhouse failed: The operation was aborted due
 * to timeout`, while that same board answered a manual request in 0.4s with
 * 927KB of JSON. A single timeout is a blip, not a dead board.
 *
 * The other direction matters just as much: a 404 or 403 on a known slug means
 * the company moved or closed the board, and the caller's answer to that is to
 * clear the provider hint and re-probe next run. Retrying those three times
 * only delays the re-probe.
 */
import { fetchJson, fetchText, isTransportFailure } from '../inngest/functions/sources/connectors/ats.ts';
import { sourceRunStatus } from '../inngest/functions/sources/types.ts';

let fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) fail++;
}

const named = (name: string, message: string) => {
  const e = new Error(message);
  e.name = name;
  return e;
};

/** The exact error Sudden's ATS source recorded every run for 19.5h. */
const timeout = () => named('TimeoutError', 'The operation was aborted due to timeout');

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

console.log('\nA transport blip is worth another attempt:');
ok('the timeout that stalled CrunchyRoll', isTransportFailure(timeout()));
ok('a caller-side abort', isTransportFailure(named('AbortError', 'This operation was aborted')));
ok('a dropped connection', isTransportFailure(named('TypeError', 'fetch failed')));
ok('a 200 whose body was truncated mid-JSON', isTransportFailure(named('SyntaxError', 'Unexpected end of JSON input')));

console.log('\nAnything a person or a re-probe has to fix is thrown straight through:');
ok('a bug in our own code', !isTransportFailure(named('ReferenceError', 'slug is not defined')));
ok('a thrown string', !isTransportFailure('boom'));

async function main() {
console.log('\nAn HTTP status is returned, never retried:');
for (const status of [403, 404, 410, 500]) {
  let calls = 0;
  const res = await fetchJson<unknown>('https://boards.example/jobs', {}, async () => {
    calls++;
    return jsonResponse({ error: 'nope' }, status);
  });
  ok(`${status} answers after exactly 1 call`, calls === 1 && !res.ok && res.status === status, `calls=${calls} ok=${res.ok} status=${res.status}`);
}

console.log('\nHow many times the same board actually gets asked:');
{
  let calls = 0;
  const res = await fetchJson<{ jobs: number[] }>('https://boards.example/jobs', {}, async () => {
    calls++;
    if (calls === 1) throw timeout();
    return jsonResponse({ jobs: [1, 2, 3] });
  });
  ok('a timeout on the first attempt still returns the board', res.ok && res.body.jobs.length === 3);
  ok('and it took exactly 2 attempts', calls === 2, `calls=${calls}`);
}
{
  let calls = 0;
  let thrown: unknown;
  try {
    await fetchJson<unknown>('https://boards.example/jobs', {}, async () => { calls++; throw timeout(); });
  } catch (e) { thrown = e; }
  ok('a board that stays slow gives up after 3 attempts', calls === 3, `calls=${calls}`);
  ok('and the original error reaches the caller, so the source still records it', thrown instanceof Error && (thrown as Error).name === 'TimeoutError');
}
{
  let calls = 0;
  const res = await fetchJson<{ jobs: number[] }>('https://boards.example/jobs', {}, async () => {
    calls++;
    return jsonResponse({ jobs: [1] });
  });
  ok('a healthy board is one call, unchanged', calls === 1 && res.ok && res.body.jobs.length === 1, `calls=${calls}`);
}
{
  let seenMethod: string | undefined;
  await fetchJson<unknown>('https://boards.example/jobs', { method: 'POST', body: '{"query":""}' }, async (_u, init) => {
    seenMethod = (init as RequestInit).method;
    return jsonResponse({ results: [] });
  });
  ok('the caller\'s method and body survive the wrapper (Workable posts)', seenMethod === 'POST', `method=${seenMethod}`);
}

console.log('\nThe discovery probe reads HTML and retries the same way:');
{
  let calls = 0;
  const res = await fetchText('https://boards.greenhouse.io/acme', {}, async () => {
    calls++;
    if (calls === 1) throw timeout();
    return new Response('<html>acme.com</html>', { status: 200 });
  });
  ok('a timeout on the board page still returns the HTML', res.ok && res.body.includes('acme.com'));
  ok('and it took exactly 2 attempts', calls === 2, `calls=${calls}`);
  // Without this, a stalled probe reads as "not our company" and the entity is
  // marked as having no ATS until the next re-probe, up to reprobe_days away.
}

console.log('\nA source is red only when the run did no work:');
const run = (o: Partial<{ signals_created: number; entities_created: number; skipped: number; errors: string[] }>) =>
  sourceRunStatus({ signals_created: 0, entities_created: 0, skipped: 0, errors: [], ...o });
ok('a clean run is ok', run({ signals_created: 3 }) === 'ok');
ok('the run that sat red for 19.5h is ok (1 board timed out, 496 processed, 1 signal)',
  run({ signals_created: 1, skipped: 496, errors: ['CrunchyRoll fetch greenhouse failed: The operation was aborted due to timeout'] }) === 'ok');
ok('errors with nothing to show for the run is error', run({ errors: ['everything timed out'] }) === 'error');
ok('a quiet run with no errors is ok, not red', run({}) === 'ok');
ok('entities created despite an error is ok', run({ entities_created: 2, errors: ['one board 500ed'] }) === 'ok');

console.log(fail === 0 ? '\nOK: ats retry assertions passed' : `\nFAILED: ${fail} assertion(s)`);
process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
