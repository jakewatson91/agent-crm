/**
 * A/B the enricher on REAL stored pages. No Exa spend.
 *
 * Runs the same page through the old prompt (no brief) and the new one (brief),
 * and prints both fact lists side by side. Fact bloat is the complaint, so the
 * numbers that matter are facts-per-page and how many of them a person would
 * call usable.
 *
 * Usage: pnpm tsx scripts/_gq_13_enrichab.ts [--n 6] [--account "ViX"]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { chatComplete } from '@agent-crm/primitives';
import { getPolicy, resolveBrief } from '@agent-crm/tools';
import { buildSystemPrompt, buildUserPrompt } from '../inngest/functions/agent_logic.ts';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const args = process.argv.slice(2);
const nArg = args.indexOf('--n');
const N = nArg > -1 ? Number(args[nArg + 1]) : 6;
const aArg = args.indexOf('--account');
const ACCOUNT = aArg > -1 ? args[aArg + 1]! : null;
const MODEL = 'deepseek-v4-flash';

(async () => {
  const ws = (await sb.from('workspaces').select('about, constitution, persona, icp').eq('id', WS).maybeSingle()).data as any;
  const policy = await getPolicy(sb as any, WS);
  const brief = resolveBrief(policy);
  const examples = (policy.enrichment?.example_facts ?? []) as Array<{ predicate: string; object_text: string }>;
  const banned = (policy.enrichment?.banned_predicates ?? []) as string[];

  let q = sb.from('signals').select('id, entity_id, type, magnitude, observed_at, structured_tags, body_for_embedding')
    .eq('workspace_id', WS).eq('type', 'research_result')
    .order('observed_at', { ascending: false }).limit(N * 4);
  if (ACCOUNT) {
    const e = (await sb.from('entities').select('id').eq('workspace_id', WS).ilike('name', ACCOUNT).limit(1).maybeSingle()).data as any;
    if (e) q = q.eq('entity_id', e.id) as any;
  }
  const sigs = ((await q).data ?? []).filter((s: any) => (s.body_for_embedding ?? '').length > 300).slice(0, N);

  const mk = (withBrief: boolean) => buildSystemPrompt(
    'enricher', ws.about ?? '', ws.constitution ?? '', ws.persona, ws.icp,
    { examples, banned, brief: withBrief ? brief : [] },
  );
  const sysOld = mk(false);
  const sysNew = mk(true);

  let oldTot = 0, newTot = 0;
  const oldPreds = new Set<string>(), newPreds = new Set<string>();

  for (const s of sigs as any[]) {
    const ent = (await sb.from('entities').select('id, name, attributes').eq('id', s.entity_id).maybeSingle()).data as any;
    const facts = ((await sb.from('facts').select('id, predicate, object_text, confidence, supersedes')
      .eq('subject_entity', s.entity_id).limit(400)).data ?? []) as any[];
    const sup = new Set(facts.map((f) => f.supersedes).filter(Boolean));
    const active = facts.filter((f) => !sup.has(f.id)).slice(0, 60);

    const user = buildUserPrompt('enricher', 'research', 'new research on an account', s,
      { id: ent.id, name: ent.name, attributes: ent.attributes }, active as any);

    const run = async (sys: string) => {
      try {
        const llm = await chatComplete({ model: MODEL, max_tokens: 2000, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] });
        return (JSON.parse(llm.text).facts ?? []) as Array<{ predicate: string; object_text: string }>;
      } catch (e) { return [{ predicate: '(ERROR)', object_text: String(e).slice(0, 80) }]; }
    };
    const [a, b] = await Promise.all([run(sysOld), run(sysNew)]);
    oldTot += a.length; newTot += b.length;
    for (const f of a) oldPreds.add(f.predicate);
    for (const f of b) newPreds.add(f.predicate);

    console.log(`\n=== ${ent.name}  ${String(s.structured_tags?.url ?? '').slice(0, 95)}`);
    console.log(`--- OLD (no brief): ${a.length} facts`);
    for (const f of a) console.log(`      · ${f.predicate} = ${String(f.object_text ?? '').slice(0, 88)}`);
    console.log(`--- NEW (brief):    ${b.length} facts`);
    for (const f of b) console.log(`      · ${f.predicate} = ${String(f.object_text ?? '').slice(0, 88)}`);
  }

  const slotted = [...newPreds].filter((p) => brief.some((qq) => p.startsWith(`${qq.id}.`)));
  console.log(`\n\n=== TOTALS over ${sigs.length} pages ===`);
  console.log(`  OLD  facts=${oldTot}  (${(oldTot / sigs.length).toFixed(1)}/page)  distinct predicates=${oldPreds.size}`);
  console.log(`  NEW  facts=${newTot}  (${(newTot / sigs.length).toFixed(1)}/page)  distinct predicates=${newPreds.size}`);
  console.log(`  NEW predicates inside a brief slot: ${slotted.length}/${newPreds.size} (${((slotted.length / Math.max(newPreds.size, 1)) * 100).toFixed(0)}%)`);
  const offBrief = [...newPreds].filter((p) => !slotted.includes(p));
  if (offBrief.length) console.log(`  NEW predicates OUTSIDE any slot: ${offBrief.join(', ')}`);
})();
