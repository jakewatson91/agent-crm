/**
 * One-off: fill facts.happened_at on facts that already exist.
 *
 * The column is written by the enricher from here on, but every fact asserted
 * before it existed reads as undated, and undated means "cannot be the reason we
 * wrote to this company". Without this pass the anchor test starves the whole
 * book on day one and the pipeline correctly writes nothing.
 *
 * Scope is deliberately narrow, because this is the one place the classification
 * costs money rather than riding along on an enricher call that was happening
 * anyway:
 *   - accounts at or above the fit floor the advance walk uses. Below it nothing
 *     drafts, so a date there buys nothing.
 *   - facts whose source page carries a date inside the window. A fact with no
 *     source date resolves to null even when it IS an event, so classifying it
 *     would spend a call to write the value it already has.
 *   - facts with happened_at still null. Re-runnable: it only ever fills blanks.
 *
 * Facts are batched across accounts, 25 to a call, because event-vs-state is a
 * judgment about the sentence rather than about the company.
 *
 *   tsx scripts/backfill_happened_at.ts <workspace_id> [--days 90] [--limit 2000] [--apply]
 *
 * Prints what it would do and writes nothing unless --apply is passed.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import {
  chatCompleteForWorkspace, resolveHappenedAt, isSubstantiveFact,
  buildThresholds, getPolicy,
} from '@agent-crm/tools';

const WS = process.argv[2];
if (!WS) throw new Error('usage: backfill_happened_at.ts <workspace_id> [--days N] [--limit N] [--apply]');
const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
};
const DAYS = arg('days', 90);
const LIMIT = arg('limit', 2000);
const APPLY = process.argv.includes('--apply');
const BATCH = 25;

interface FactRow {
  id: string; subject_entity: string; predicate: string; object_text: string | null;
  supersedes: string | null; signal_id: string | null; happened_at: string | null;
}

async function fetchAllRows<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw new Error(String((error as { message?: string }).message ?? error));
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

async function main() {
  const supabase = createServerClient();
  const policy = await getPolicy(supabase, WS);
  const T = buildThresholds(policy.routing, policy.drafter?.outreach_channel);
  const sinceISO = new Date(Date.now() - DAYS * 86400_000).toISOString();

  // ---- 1. Accounts worth spending on ----
  const scoreRows = await fetchAllRows<{ id: string; subject_entity: string; object_text: string | null; supersedes: string | null }>(
    (f, t) => supabase.from('facts').select('id, subject_entity, object_text, supersedes')
      .eq('workspace_id', WS).eq('predicate', 'score_total').order('id', { ascending: true }).range(f, t));
  // The current row is the one no other row POINTS AT. `.is('supersedes', null)`
  // reads the stale original — the score an account was given the first time it
  // was ever seen — which is the read bug this codebase has shipped twice.
  const pointedAt = new Set(scoreRows.map((r) => r.supersedes).filter((x): x is string => !!x));
  const eligible = new Set<string>();
  for (const r of scoreRows) {
    if (pointedAt.has(r.id)) continue;
    const v = parseFloat(r.object_text ?? '');
    if (Number.isFinite(v) && v >= T.ENRICH_CONTACTS_ACCOUNT_ICP) eligible.add(r.subject_entity);
  }
  console.log(`accounts at or above the ${T.ENRICH_CONTACTS_ACCOUNT_ICP} fit floor: ${eligible.size}`);

  // ---- 2. Their undated facts ----
  const factRows = await fetchAllRows<FactRow>(
    (f, t) => supabase.from('facts').select('id, subject_entity, predicate, object_text, supersedes, signal_id, happened_at')
      .eq('workspace_id', WS).is('happened_at', null).order('id', { ascending: true }).range(f, t));
  const factPointedAt = new Set(factRows.map((r) => r.supersedes).filter((x): x is string => !!x));
  const candidates = factRows.filter((f) =>
    !factPointedAt.has(f.id) &&
    eligible.has(f.subject_entity) &&
    !!f.signal_id &&
    !!f.object_text &&
    isSubstantiveFact(f.predicate));
  console.log(`their live substantive facts with a source, still undated: ${candidates.length}`);

  // ---- 3. Which of those sources carry a date in the window ----
  const sigIds = [...new Set(candidates.map((f) => f.signal_id!))];
  const dateBySig = new Map<string, string>();
  for (let i = 0; i < sigIds.length; i += 200) {
    const { data } = await supabase.from('signals').select('id, structured_tags').in('id', sigIds.slice(i, i + 200));
    for (const s of (data ?? []) as Array<{ id: string; structured_tags: { published_at?: string | null } | null }>) {
      const pub = s.structured_tags?.published_at;
      if (pub && Number.isFinite(Date.parse(pub)) && pub >= sinceISO) dateBySig.set(s.id, pub);
    }
  }
  const work = candidates.filter((f) => dateBySig.has(f.signal_id!)).slice(0, LIMIT);
  console.log(`dated inside the last ${DAYS} days, so worth a call: ${work.length}`);
  if (!work.length) { console.log('nothing to do'); return; }
  console.log(`${Math.ceil(work.length / BATCH)} calls at ${BATCH} facts each\n`);

  // ---- 4. Classify ----
  const system = `You decide, for each numbered claim about a company, whether it records something that HAPPENED at a point in time or describes how the company STANDS.

An EVENT happened on a date: they launched, shipped, signed, raised, hired, opened, acquired, announced a plan, published a figure, changed something. Test it by finishing "On <some date>, they <did this>."
STATE is what a company is or has: what it sells, who it serves, what it runs on, where it operates, its size, its category, a problem it has. Most claims are state, and saying so is the normal answer.
The test is not how interesting or how recent the claim is. "Serves 4 million subscribers" is state. "Added 4 million subscribers during the tournament" is an event.

For each claim also give "date": the date the claim itself states the thing happened, as YYYY-MM-DD, or "" when the claim does not say. Do not infer, do not estimate, do not use today. Most will be "".

Output strictly valid JSON: {"claims":[{"n":<number>,"is_event":true|false,"date":"<YYYY-MM-DD or empty>"},...]}`;

  let events = 0, state = 0, unparsed = 0, written = 0;
  const updates: Array<{ id: string; happened_at: string }> = [];
  // A dry run that only prints counts cannot be checked. The split between event
  // and state is the entire judgment this pass makes, and it is judged by
  // reading a dozen of them, not by the ratio.
  const SAMPLES = 12;
  const samples: { event: string[]; state: string[] } = { event: [], state: [] };

  for (let i = 0; i < work.length; i += BATCH) {
    const batch = work.slice(i, i + BATCH);
    const user = batch.map((f, n) => `${n + 1}. ${f.predicate}: ${f.object_text}`).join('\n');
    let parsed: { claims?: Array<{ n: number; is_event: boolean; date?: string }> } = {};
    try {
      const llm = await chatCompleteForWorkspace(supabase, WS, {
        // The same cheap model the angle picker runs on. resolveArgs overrides
        // it with the workspace's own default_chat_model when one is set, so
        // this is a starting point rather than a choice made here.
        model: 'deepseek-v4-flash',
        behavior: 'connector_extract',
        max_tokens: 2000,
        temperature: 0,
        thinking: 'disabled',
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      parsed = JSON.parse(String(llm.text ?? '{}'));
    } catch (e) {
      unparsed += batch.length;
      console.log(`  batch ${i / BATCH + 1}: FAILED (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const byN = new Map((parsed.claims ?? []).map((c) => [c.n, c]));
    for (let n = 0; n < batch.length; n++) {
      const f = batch[n]!;
      const c = byN.get(n + 1);
      if (!c) { unparsed++; continue; }
      const happened = resolveHappenedAt({
        isEvent: c.is_event,
        eventDate: c.date,
        sourceDate: dateBySig.get(f.signal_id!),
      });
      if (happened) {
        events++;
        updates.push({ id: f.id, happened_at: happened });
        if (samples.event.length < SAMPLES) samples.event.push(`${happened.slice(0, 10)}  ${f.predicate}: ${(f.object_text ?? '').slice(0, 90)}`);
      } else {
        state++;
        if (samples.state.length < SAMPLES) samples.state.push(`${c.is_event ? 'event, undatable' : 'state'}  ${f.predicate}: ${(f.object_text ?? '').slice(0, 90)}`);
      }
    }
    process.stdout.write(`  batch ${i / BATCH + 1}/${Math.ceil(work.length / BATCH)}: ${events} events so far\r`);
  }
  console.log('');

  // ---- 5. Write ----
  if (APPLY) {
    for (const u of updates) {
      // .is(null) again: never overwrite a date a live enricher run set while
      // this was working through the backlog.
      const { error } = await supabase.from('facts').update({ happened_at: u.happened_at })
        .eq('id', u.id).is('happened_at', null);
      if (!error) written++;
    }
    await supabase.from('events').insert({
      workspace_id: WS, actor_kind: 'system', actor_id: 'backfill_happened_at',
      action: 'backfill_completed', target_kind: 'workspace', target_id: WS,
      payload: { column: 'happened_at', classified: work.length, events, state, unparsed, written, window_days: DAYS },
    });
  }

  console.log('\nCALLED EVENTS (these become anchors):');
  for (const s of samples.event) console.log(`  ${s}`);
  console.log('\nNOT ANCHORS:');
  for (const s of samples.state) console.log(`  ${s}`);

  console.log(`\nclassified ${work.length}: ${events} events, ${state} state, ${unparsed} unreadable`);
  console.log(APPLY ? `wrote happened_at on ${written} facts` : 'DRY RUN — pass --apply to write');

  // The number that decides whether the anchor test has anything to work with.
  const accountsWithAnchor = new Set(updates.map((u) => work.find((f) => f.id === u.id)!.subject_entity));
  console.log(`accounts that would gain a dated event: ${accountsWithAnchor.size}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
