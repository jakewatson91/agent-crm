/**
 * Explain research for one account, end to end, in one command.
 *
 * This is the debugging tool for the whole loop. Every stage now shares the
 * research brief, so a bad outcome is always traceable to one of four places,
 * and this prints all four in order:
 *
 *   1. the BRIEF      — what this workspace needs to know
 *   2. the ANGLES     — which search buys which question
 *   3. the PAGES      — what each search bought, kept or dropped, and why
 *   4. the FACTS      — what was written down, grouped by the question it answers
 *
 * Read it top to bottom and the failure names itself: a question with no angle
 * is a coverage gap, an angle whose pages all say `no_answer` is a bad query,
 * a kept page with no facts is an extraction miss, and a fact under `(no slot)`
 * predates the brief.
 *
 * Read-only. Spends nothing.
 *
 * Usage: pnpm tsx scripts/research_explain.ts "ViX" [--ws <id>] [--days 30]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { getPolicy, resolveBrief } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
// Parse positionally so a flag's VALUE is never mistaken for the account name
// (an earlier version filtered by value-equality and ate the name whenever it
// matched a flag argument).
const argv = process.argv.slice(2);
let WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
let DAYS = 30;
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === '--ws') { WS = argv[++i] ?? WS; continue; }
  if (a === '--days') { DAYS = Number(argv[++i]) || DAYS; continue; }
  if (a.startsWith('--')) continue;
  positional.push(a);
}
const NAME = positional[0];

function pct(n: number, d: number): string { return d ? `${((n / d) * 100).toFixed(0)}%` : '-'; }

(async () => {
  if (!NAME) { console.log('usage: research_explain.ts "<account name>"'); return; }
  const policy = await getPolicy(sb as any, WS);
  const brief = resolveBrief(policy);
  const angles = policy.research?.strategy ?? [];

  const ent = (await sb.from('entities').select('id, name, attributes')
    .eq('workspace_id', WS).ilike('name', NAME).limit(1).maybeSingle()).data as any;
  if (!ent) { console.log(`no account named "${NAME}"`); return; }

  console.log(`ACCOUNT  ${ent.name}   domain=${ent.attributes?.domain ?? '(none)'}\n`);

  // ---- 1. brief ----
  console.log('1. BRIEF — what this workspace needs to know');
  for (const q of brief) {
    const served = angles.filter((a) => a.answers === q.id).map((a) => a.id);
    console.log(`   [${q.id}]  ${served.length ? `searched by: ${served.join(', ')}` : 'no angle (noticed on pages fetched for other questions)'}`);
    console.log(`        ${q.question}`);
  }

  // ---- 2. angles ----
  console.log('\n2. ANGLES — which search buys which question');
  for (const a of angles) {
    console.log(`   ${String(a.id).padEnd(20)} ${String(a.domain_scope).padEnd(9)} ${String(a.recency_days ?? 'none').padStart(4)}d  -> ${a.answers ?? '(unassigned)'}`);
    console.log(`        ${a.query_template}`);
  }
  const orphanAngles = angles.filter((a) => a.answers && !brief.some((q) => q.id === a.answers));
  if (orphanAngles.length) console.log(`   !! angles pointing at a question that no longer exists: ${orphanAngles.map((a) => a.id).join(', ')}`);

  // ---- 3. pages ----
  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
  const sigs = (await sb.from('signals')
    .select('id, structured_tags, observed_at, magnitude, body_for_embedding')
    .eq('workspace_id', WS).eq('entity_id', ent.id).eq('type', 'research_result')
    .gte('observed_at', since).order('observed_at', { ascending: false }).limit(200)).data ?? [];

  const factsBySig = new Map<string, any[]>();
  const ids = sigs.map((s: any) => s.id);
  for (let i = 0; i < ids.length; i += 200) {
    const r = await sb.from('facts').select('id, signal_id, predicate, object_text').in('signal_id', ids.slice(i, i + 200));
    for (const f of r.data ?? []) { if (!factsBySig.has(f.signal_id)) factsBySig.set(f.signal_id, []); factsBySig.get(f.signal_id)!.push(f); }
  }

  console.log(`\n3. PAGES KEPT — ${sigs.length} in the last ${DAYS}d (drops are not stored; see the run markers below)`);
  let zero = 0;
  for (const s of sigs as any[]) {
    const t = s.structured_tags ?? {};
    const fs = factsBySig.get(s.id) ?? [];
    if (!fs.length) zero++;
    console.log(`   ${String(t.answers_question ?? '(pre-brief)').padEnd(20)} ${String(t.hook_class ?? '-').padEnd(11)} pub=${String(t.published_at ?? 'none').slice(0, 10).padEnd(10)} facts=${String(fs.length).padStart(2)}  ${String(t.url).slice(0, 92)}`);
    for (const f of fs) console.log(`        · ${f.predicate} = ${String(f.object_text ?? '').slice(0, 100)}`);
  }
  if (sigs.length) console.log(`   pages that produced no facts: ${zero} of ${sigs.length} (${pct(zero, sigs.length)})`);

  // ---- run markers: what the gate rejected ----
  const ev = ((await sb.from('events').select('payload, created_at')
    .eq('workspace_id', WS).eq('action', 'research_completed').eq('target_id', ent.id)
    .gte('created_at', since).order('created_at', { ascending: false }).limit(20)).data ?? []) as any[];
  console.log(`\n   run markers (${ev.length}):`);
  for (const e of ev) {
    const d = e.payload ?? {};
    console.log(`     ${e.created_at.slice(0, 16)}  searches=${d.searches} kept=${d.results_created} by_question=${JSON.stringify(d.per_question ?? {})} dropped=${JSON.stringify(d.filtered_by ?? {})}${d.gate_unreadable ? ` GATE_UNREADABLE=${d.gate_unreadable}` : ''}${d.gate_omitted ? ` omitted=${d.gate_omitted}` : ''}`);
    // Read these. A page here that you would have kept is a MISSING BRIEF
    // QUESTION, not a gate bug — the gate can only keep what something asks for.
    for (const s2 of d.drop_sample ?? []) console.log(`        dropped[${s2.why}] via ${s2.angle}: ${String(s2.title).slice(0, 70)}  ${String(s2.url).slice(0, 80)}`);
  }

  // ---- 4. facts, grouped by the question the PAGE they came from answered ----
  // Not by a prefix on the fact's name. Fact names are flat; the link to a
  // question lives on the page (`signals.structured_tags.answers_question`) and
  // every research fact carries `signal_id`. That grouping survives a question
  // being reworded or retired, which a name prefix did not.
  const all = (await sb.from('facts').select('id, predicate, object_text, supersedes, signal_id, created_at')
    .eq('workspace_id', WS).eq('subject_entity', ent.id).limit(2000)).data ?? [];
  const sup = new Set(all.map((f: any) => f.supersedes).filter(Boolean));
  const active = (all as any[]).filter((f) => !sup.has(f.id));

  // Every page this account's facts point at, not just the recent window above.
  const sigIds = [...new Set(active.map((f) => f.signal_id).filter(Boolean))];
  const qBySignal = new Map<string, string>();
  for (let i = 0; i < sigIds.length; i += 200) {
    const r = await sb.from('signals').select('id, structured_tags').in('id', sigIds.slice(i, i + 200));
    for (const s2 of (r.data ?? []) as any[]) {
      const q = s2.structured_tags?.answers_question;
      if (q) qBySignal.set(s2.id, q);
    }
  }

  const byQ = new Map<string, any[]>();
  for (const f of active) {
    if (/^score_|_breakdown$|^icp_fit$/.test(f.predicate)) continue;
    const q = f.signal_id ? qBySignal.get(f.signal_id) : undefined;
    const key = q ?? '(no page link — imported, scored, or pre-brief)';
    if (!byQ.has(key)) byQ.set(key, []);
    byQ.get(key)!.push(f);
  }

  console.log('\n4. FACTS ON FILE, by the question the page they came from answered');
  for (const q of brief) {
    const fs = byQ.get(q.id) ?? [];
    console.log(`   [${q.id}] ${fs.length} fact(s)${fs.length ? '' : '  <- nothing found for this yet'}`);
    for (const f of fs.slice(0, 8)) console.log(`        · ${f.predicate} = ${String(f.object_text ?? '').slice(0, 100)}`);
  }
  // Questions that no longer exist in the brief but whose pages still carry facts.
  for (const [k, fs] of byQ) {
    if (brief.some((q) => q.id === k) || k.startsWith('(no page link')) continue;
    console.log(`   [${k}] ${fs.length} fact(s)  <- RETIRED question; facts kept and still readable`);
  }
  const orphan = byQ.get('(no page link — imported, scored, or pre-brief)') ?? [];
  console.log(`   (no page link) ${orphan.length} fact(s) — imported, or written before the brief existed`);
  for (const f of orphan.slice(0, 10)) console.log(`        · ${f.predicate} = ${String(f.object_text ?? '').slice(0, 90)}`);
  if (orphan.length > 10) console.log(`        ... and ${orphan.length - 10} more`);
})();
