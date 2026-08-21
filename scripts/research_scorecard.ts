/**
 * What has each research question actually earned?
 *
 * The brief is a hypothesis about what matters. This is how it gets corrected:
 * a track record per question, read off data already stored — run markers,
 * page records, facts, and the drafts that cited them. Nothing new is written.
 *
 * The three columns diagnose DIFFERENT failures, and keeping them apart is the
 * whole point:
 *
 *   fetched high, kept low     -> the SEARCH is wrong, not the question.
 *                                 Reword the query. Do not retire the question.
 *   kept high, facts low       -> extraction problem. The pages are right and
 *                                 nothing is being read off them.
 *   facts high, used-in-a-draft 0 -> the question genuinely does not matter for
 *                                 messages. This is the only column that
 *                                 justifies retiring it.
 *
 * Mixing those up is how you delete a good question because someone wrote a bad
 * search for it.
 *
 * Sample sizes are printed because they are small and honest reading depends on
 * them: a question with a handful of searches is UNPROVEN, not failing.
 *
 * Read-only. Spends nothing.
 *
 * Usage: pnpm tsx scripts/research_scorecard.ts [--days 30] [--ws <id>]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { getPolicy, resolveBrief, loadQuestionRecords, earnsItsSearches, unreachableQuestions, FAIR_TRIAL_PAGES, UNREACHABLE_TRIALS } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const argv = process.argv.slice(2);
let WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
let DAYS = 30;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--ws') WS = argv[++i] ?? WS;
  else if (argv[i] === '--days') DAYS = Number(argv[++i]) || DAYS;
}

async function fetchAll<T>(build: (f: number, t: number) => any): Promise<T[]> {
  let out: T[] = []; let f = 0; const pg = 1000;
  for (;;) { const { data, error } = await build(f, f + pg - 1); if (error) throw error; if (!data?.length) break; out = out.concat(data); if (data.length < pg) break; f += pg; }
  return out;
}

(async () => {
  const policy = await getPolicy(sb as any, WS);
  const brief = resolveBrief(policy);
  // Enabled only. A switched-off angle is not running, so counting it as serving
  // a question hides the case that matters: a question whose only search was
  // turned off reads as covered while nothing is looking for it.
  const angles = (policy.research?.strategy ?? []).filter((a) => a.enabled !== false);
  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();

  // --- run markers: fetched + kept per search ---
  // .limit(5000) reads as "everything" and is not: PostgREST stops at 1000 rows.
  // This screen was printing "1000 research runs, 3931 searches" for a window
  // that actually held 1,125 runs and 4,277 searches, and the round number is
  // the only tell. Per-question fetched came out the same either way, because
  // the runs it dropped carried no per-search counts, today.
  const ev = await fetchAll<any>((f, t) => sb.from('events').select('payload, created_at')
    .eq('workspace_id', WS).eq('action', 'research_completed')
    .gte('created_at', since).order('created_at').order('id').range(f, t));
  const fetchedByAngle: Record<string, number> = {};
  const keptByAngle: Record<string, number> = {};
  let runs = 0, searches = 0, markersWithFetched = 0;
  for (const e of ev) {
    const d = e.payload ?? {};
    runs++; searches += d.searches ?? 0;
    if (d.per_angle_fetched) markersWithFetched++;
    for (const [k, v] of Object.entries(d.per_angle_fetched ?? {})) fetchedByAngle[k] = (fetchedByAngle[k] ?? 0) + (v as number);
    for (const [k, v] of Object.entries(d.per_angle ?? {})) keptByAngle[k] = (keptByAngle[k] ?? 0) + (v as number);
  }

  // --- pages kept, per question ---
  // The order is not decoration: 1,777 signals in this window is two pages, and
  // range pagination without a total order can skip or repeat rows at the seam.
  // `observed_at` is selected because the rewritten-search block below dates
  // these rows. Filtering on a column that was never selected reads `undefined`,
  // `Date.parse` gives NaN, and every `>=` is false — so that block reported
  // "0 kept since the rewrite" for every rewritten search no matter what had
  // been kept. It read as three dead angles; 93 pages had been kept.
  const sigs = await fetchAll<any>((f, t) => sb.from('signals')
    .select('id, structured_tags, observed_at').eq('workspace_id', WS).eq('type', 'research_result')
    .gte('observed_at', since).order('observed_at').order('id').range(f, t));
  const keptByQuestion: Record<string, number> = {};
  const sigQ = new Map<string, string>();
  for (const s of sigs) {
    const q = s.structured_tags?.answers_question;
    if (!q) continue;
    sigQ.set(s.id, q);
    keptByQuestion[q] = (keptByQuestion[q] ?? 0) + 1;
  }

  // The four numbers the brief planner is judged on come from ONE definition,
  // shared with it. Computing them separately here is how the screen and the
  // model end up disagreeing about the same question.
  const shared = new Map((await loadQuestionRecords(sb as any, WS, DAYS)).map((r) => [r.id, r]));

  // --- facts off those pages ---
  const sigIds = [...sigQ.keys()];
  const factsByQuestion: Record<string, number> = {};
  const factIdQ = new Map<string, string>();
  for (let i = 0; i < sigIds.length; i += 200) {
    const r = await sb.from('facts').select('id, signal_id').in('signal_id', sigIds.slice(i, i + 200)).limit(3000);
    for (const f of (r.data ?? []) as any[]) {
      const q = sigQ.get(f.signal_id);
      if (!q) continue;
      factsByQuestion[q] = (factsByQuestion[q] ?? 0) + 1;
      factIdQ.set(f.id, q);
    }
  }

  // --- which of those facts a draft actually used ---
  const chans = (await sb.from('channels').select('id').eq('workspace_id', WS).limit(5000)).data ?? [];
  const chanIds = (chans as any[]).map((c) => c.id);
  let posts: any[] = [];
  for (let i = 0; i < chanIds.length; i += 200) {
    const r = await sb.from('channel_posts').select('cites, kind, created_at')
      .in('channel_id', chanIds.slice(i, i + 200)).eq('kind', 'touch_draft').gte('created_at', since).limit(2000);
    posts = posts.concat(r.data ?? []);
  }
  const usedByQuestion: Record<string, number> = {};
  const citedIds = new Set<string>();
  for (const p of posts) for (const c of p.cites ?? []) citedIds.add(c);
  for (const id of citedIds) {
    const q = factIdQ.get(id);
    if (q) usedByQuestion[q] = (usedByQuestion[q] ?? 0) + 1;
  }

  // --- render ---
  console.log(`workspace ${WS}  last ${DAYS}d: ${runs} research runs, ${searches} searches, ${posts.length} drafts`);
  if (runs && markersWithFetched < runs) {
    console.log(`  note: ${runs - markersWithFetched} run(s) predate per-search fetch counts — "fetched" is understated for those.`);
  }
  // "fetched" is now charged to the question at the moment the page is bought, so
  // it survives the search being rewritten. Runs before that are reconstructed
  // through whichever angle serves the question today, and only from the date the
  // brief was written — nothing can have answered a question before it existed.
  // So right after a brief regeneration every row reads as unproven, which is
  // true, rather than carrying a month of a predecessor question's spend.
  const briefAt = policy.research?.brief_generated_at;
  if (briefAt && Date.parse(briefAt) > Date.parse(since)) {
    console.log(`  note: the brief was rewritten ${briefAt.slice(0, 10)}; pages bought before then are not charged to these questions.`);
  }
  console.log('');
  const head = 'question'.padEnd(24) + 'searches'.padStart(9) + 'fetched'.padStart(9) + 'kept'.padStart(6) + 'hit%'.padStart(6) + 'facts'.padStart(7) + 'used'.padStart(6) + '   verdict';
  // No derived searches-per-question column. It would be runs x searches aimed
  // at that question, which over-counts: cold accounts run fewer searches, a
  // domainless account skips own-site ones entirely. `fetched` is measured, so
  // it is the denominator worth trusting.
  console.log(head);
  console.log('-'.repeat(head.length + 20));

  // A rewritten search keeps its angle id, so pages bought by a query that no
  // longer exists sit alongside pages bought by the one running now. The
  // question-level row no longer conflates them, but the per-angle numbers below
  // still do, and the day after a fix that reads as though the fix did not land.
  const rewritten: string[] = [];

  const questionIds = [...new Set([...brief.map((q) => q.id), ...Object.keys(keptByQuestion)])];
  const unreachable = new Set(unreachableQuestions([...shared.values()]));
  for (const qid of questionIds) {
    const inBrief = brief.some((q) => q.id === qid);
    const serving = angles.filter((a) => a.answers === qid);
    const r = shared.get(qid);
    const fetched = r?.fetched ?? serving.reduce((n, a) => n + (fetchedByAngle[a.id] ?? 0), 0);
    const kept = r?.kept ?? keptByQuestion[qid] ?? 0;
    const facts = r?.facts ?? factsByQuestion[qid] ?? 0;
    const used = r?.used ?? usedByQuestion[qid] ?? 0;
    const hit = fetched ? Math.round((kept / fetched) * 100) : 0;

    let verdict: string;
    if (!inBrief) verdict = 'RETIRED — facts kept and still readable';
    // Read before "no search points at it": once a question is ruled unreachable
    // it HAS no angle, and the older line would report that as an oversight.
    else if (unreachable.has(qid)) verdict = `NO SEARCH ANSWERS THIS — ${UNREACHABLE_TRIALS} fair trials spent, searches stopped; still watched on pages bought for other questions`;
    else if (!serving.length) verdict = 'no search points at it (found only in passing)';
    else if (fetched < FAIR_TRIAL_PAGES) verdict = `unproven (needs ${FAIR_TRIAL_PAGES}+ pages seen)`;
    else if (!earnsItsSearches({ fetched, kept })) verdict = 'THE SEARCH IS WRONG — reword the query, keep the question';
    else if (kept >= 5 && facts === 0) verdict = 'pages are right, nothing being read off them';
    else if (facts >= 10 && used === 0 && posts.length >= 20) verdict = 'RETIRE CANDIDATE — produces facts no message uses';
    else verdict = 'earning its place';

    console.log(
      qid.slice(0, 23).padEnd(24) +
      String(serving.length || '-').padStart(9) + String(fetched).padStart(9) + String(kept).padStart(6) +
      `${hit}%`.padStart(6) + String(facts).padStart(7) + String(used).padStart(6) + '   ' + verdict,
    );

    const newest = serving.map((a) => a.record_since).filter(Boolean).sort().pop();
    if (newest && Date.parse(newest) > Date.parse(since)) {
      const at = Date.parse(newest);
      const fetchedSince = ev.reduce((n, e) => Date.parse(e.created_at) >= at
        ? n + serving.reduce((m, a) => m + ((e.payload?.per_angle_fetched ?? {})[a.id] ?? 0), 0) : n, 0);
      const keptSince = sigs.filter((s) => s.structured_tags?.answers_question === qid
        && Date.parse(s.observed_at) >= at).length;
      rewritten.push(`  ${qid}: search rewritten ${newest.slice(0, 10)}. Since then ${fetchedSince} fetched by that angle, ${keptSince} kept.`);
    }
  }

  if (rewritten.length) {
    console.log('\nsearches rewritten inside this window — read these rows with that in mind:');
    for (const line of rewritten) console.log(line);
  }

  console.log(`\n"searches" is how many searches are aimed at that question, not how many ran. "fetched" is measured.`);
  if (posts.length < 20) {
    console.log(`Only ${posts.length} drafts in this window — the "used" column cannot retire anything yet. Judge on hit% and facts until it fills in.`);
  }
})();
