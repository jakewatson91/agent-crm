/**
 * Ask the stable questions about a business once, and store the answers as
 * facts, instead of re-deriving them from prose on every scoring call.
 *
 * Why this exists, with the account that forced it: the out-of-scope veto asks
 * whether a prospect's video is live only with no on-demand catalog. OVI
 * Technologies describes itself as a "sub second live streaming environment"
 * and ALSO carries an imported `product: Film/TV Streaming` tag. Two facts,
 * opposite answers. The rubric read both, correctly refused to veto on
 * contradictory evidence, and a live-only account sat at icp_fit 0.95. No
 * rewording of the condition fixes that, because the contradiction is in the
 * evidence rather than the question. Asking once and storing the answer does.
 *
 * Vertical-neutral by construction: WHICH properties matter, what they are
 * called and what values they may take all live in
 * `policy.enrichment.stable_attributes`. Nothing about video, live, or
 * on-demand appears in this file. A workspace with no config runs a no-op.
 *
 * Cost, and why the default is a dry run: one cheap-model call per account
 * (the workspace's own default chat model, the one classify_role uses — no
 * model is chosen here). Asserting a fact also makes the account eligible for
 * rescoring on its next scheduled pass, which is a rubric call per touched
 * account on the scoring model. Touching the whole book is therefore the same
 * order of spend as a full rescore. Use --limit and check the sample first.
 *
 * Usage:
 *   tsx scripts/backfill_stable_attributes.ts                    # dry run, 25 accounts
 *   tsx scripts/backfill_stable_attributes.ts --limit 200        # dry run, more
 *   tsx scripts/backfill_stable_attributes.ts --entity <uuid>    # one account
 *   tsx scripts/backfill_stable_attributes.ts --limit 200 --apply
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { callTool, chatCompleteForWorkspace, isSubstantiveFact } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.WORKSPACE_ID ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

const APPLY = process.argv.includes('--apply');
const argOf = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const LIMIT = Number(argOf('--limit') ?? 25);
const ONE = argOf('--entity');

// Same model the role classifier uses. Not a choice made here: it is the
// workspace's configured default, and chatCompleteForWorkspace overrides it
// from policy.llm when the workspace says so.
const MODEL = 'deepseek-v4-flash';

// The answer a model gives when the facts do not settle the question. Stored
// nowhere: an unknown is the absence of a fact, not a fact saying "unknown".
const UNKNOWN = 'unknown';

type Attr = { predicate: string; question: string; values: string[] };

async function pageAll<T>(build: (from: number) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await build(from);
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

async function main() {
  const { data: w, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const attrs = (((w!.policy ?? {}) as any).enrichment?.stable_attributes ?? []) as Attr[];
  const valid = attrs.filter((a) => a?.predicate?.trim() && a?.question?.trim() && (a?.values ?? []).length);
  if (!valid.length) {
    console.log('No policy.enrichment.stable_attributes configured for this workspace. Nothing to do.');
    return;
  }
  console.log(`${valid.length} stable attribute(s) configured:`);
  for (const a of valid) console.log(`  ${a.predicate}: ${a.values.join(' | ')}`);

  type FactRow = { id: string; subject_entity: string; predicate: string; object_text: string | null; supersedes: string | null };
  const rows = await pageAll<FactRow>((from) =>
    sb.from('facts').select('id, subject_entity, predicate, object_text, supersedes')
      .eq('workspace_id', WS).order('id').range(from, from + 999));
  const superseded = new Set(rows.map((r) => r.supersedes).filter(Boolean) as string[]);
  const active = rows.filter((r) => !superseded.has(r.id));

  const byEntity = new Map<string, FactRow[]>();
  for (const r of active) {
    const list = byEntity.get(r.subject_entity) ?? [];
    list.push(r);
    byEntity.set(r.subject_entity, list);
  }

  // An account is a candidate when it is missing at least one configured
  // attribute AND has enough substantive evidence for the question to be
  // answerable. Accounts carrying only bookkeeping facts are skipped: asking
  // about them spends a call to learn nothing and would assert a guess.
  const candidates: Array<{ id: string; facts: FactRow[]; missing: Attr[] }> = [];
  for (const [id, facts] of byEntity) {
    if (ONE && id !== ONE) continue;
    const has = new Set(facts.map((f) => f.predicate));
    if (!facts.some((f) => f.predicate === 'is_a' && f.object_text === 'account')) continue;
    const missing = valid.filter((a) => !has.has(a.predicate));
    if (!missing.length) continue;
    const substantive = facts.filter((f) => isSubstantiveFact(f.predicate));
    if (substantive.length < 2) continue;
    candidates.push({ id, facts, missing });
  }
  console.log(`\n${candidates.length} account(s) missing at least one attribute and carrying enough evidence to answer.`);

  const targets = candidates.slice(0, ONE ? candidates.length : LIMIT);
  console.log(`Processing ${targets.length}${APPLY ? '' : ' (dry run — nothing will be written)'}.\n`);

  const actor = { workspace_id: WS, actor_kind: 'system' as const, actor_id: 'backfill_stable_attributes' };
  const tally = new Map<string, number>();
  let asserted = 0, unknowns = 0, rejected = 0;

  // 1900 accounts one at a time is over an hour of wall clock for a job that is
  // entirely network wait. A small pool keeps it under half that without
  // pushing the provider into rate limiting.
  const POOL = Number(argOf('--concurrency') ?? 5);
  let cursor = 0;
  let done = 0;

  const processOne = async (t: typeof targets[number]) => {
    const { data: ent } = await sb.from('entities').select('name').eq('id', t.id).maybeSingle();
    const name = (ent as any)?.name ?? t.id;
    const factLines = t.facts
      .filter((f) => isSubstantiveFact(f.predicate) && (f.object_text ?? '').trim())
      .slice(0, 40)
      .map((f) => `- ${f.predicate}: ${String(f.object_text).replace(/\s+/g, ' ').slice(0, 200)}`)
      .join('\n');

    const questions = t.missing
      .map((a, i) => `${i + 1}. ${a.question}\n   Answer with exactly one of: ${a.values.join(' | ')} | ${UNKNOWN}`)
      .join('\n');

    const system = `You answer fixed questions about a company from the facts given, and nothing else.

Rules:
- Answer ONLY from the facts. Never from what a company of this type usually is.
- The facts may contradict each other. When they do, prefer what the company says about itself in its own words over a category label that looks imported or auto-assigned, and say so in your note.
- If the facts do not settle a question, answer ${UNKNOWN}. That is a normal, correct answer and is preferred over a plausible guess.

Output strictly valid JSON: {"answers": [{"n": <question number>, "value": "<one allowed value>", "note": "<under 15 words: the fact that decided it>"}]}`;

    const user = `COMPANY: ${name}\n\nFACTS:\n${factLines}\n\nQUESTIONS:\n${questions}`;

    let parsed: { answers?: Array<{ n?: unknown; value?: unknown; note?: unknown }> } = {};
    try {
      const llm = await chatCompleteForWorkspace(sb as any, WS, {
        model: MODEL,
        behavior: 'connector_extract',
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      } as any);
      parsed = JSON.parse(String((llm as any).text ?? '').replace(/^```json\s*|\s*```$/g, '').trim());
    } catch (e) {
      console.log(`  ${name}: SKIPPED (${e instanceof Error ? e.message.slice(0, 60) : 'call failed'})`);
      return;
    }

    const answers = Array.isArray(parsed.answers) ? parsed.answers : [];
    const lines: string[] = [];
    for (const a of answers) {
      const idx = Number(a.n);
      const attr = t.missing[idx - 1];
      if (!attr) continue;
      const value = String(a.value ?? '').trim();
      if (value === UNKNOWN) { unknowns++; lines.push(`    ${attr.predicate} = ${UNKNOWN} (not stored)`); continue; }
      // A value outside the configured list is the model improvising. Drop it:
      // a wrong stable attribute is worse than a missing one, because the
      // scorer will trust it for as long as it stands.
      if (!attr.values.includes(value)) {
        rejected++;
        lines.push(`    ${attr.predicate} = "${value.slice(0, 40)}" REJECTED (not an allowed value)`);
        continue;
      }
      lines.push(`    ${attr.predicate} = ${value}  (${String(a.note ?? '').slice(0, 70)})`);
      tally.set(`${attr.predicate}=${value}`, (tally.get(`${attr.predicate}=${value}`) ?? 0) + 1);
      if (APPLY) {
        const res = await callTool(sb as any, actor, 'assert_fact', {
          subject_entity: t.id,
          predicate: attr.predicate,
          object_text: value,
          confidence: 0.8,
        });
        if (res.ok) asserted++;
      }
    }
    done++;
    console.log(`  [${done}/${targets.length}] ${name}`);
    for (const l of lines) console.log(l);
  };

  await Promise.all(Array.from({ length: Math.min(POOL, targets.length) }, async () => {
    while (cursor < targets.length) {
      const t = targets[cursor++]!;
      try { await processOne(t); }
      catch (e) { console.log(`  worker error on ${t.id}: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
    }
  }));

  console.log(`\n=== ${APPLY ? 'written' : 'dry run'} ===`);
  for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${n}×  ${k}`);
  console.log(`  ${unknowns} unknown (not stored), ${rejected} rejected as not-an-allowed-value`);
  if (APPLY) console.log(`  ${asserted} facts asserted. Each touched account becomes eligible for rescore on its next pass.`);
  else console.log('  Re-run with --apply to write.');
}
main().catch((e) => { console.error(e); process.exit(1); });
