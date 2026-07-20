/**
 * Live smoke test for the deep account qualification loop.
 *   DOTENV_CONFIG_PATH=.env.local tsx -r dotenv/config scripts/_run_qualify_live.ts [name-substring]
 *
 * Picks the highest-scoring account (or one matched by name arg), runs the
 * multi-step qualification loop against it for real (spends DeepSeek + Exa), and
 * prints the verdict, the per-step trail, and the facts it asserted.
 */
import { createServerClient } from '@agent-crm/db';
import { entityIdsOfType } from '@agent-crm/tools';
import { runQualification } from '@agent-crm/agents';

const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const nameArg = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? '';

function currentValue(rows: Array<{ id: string; object_text: string | null; supersedes: string | null }>): string | null {
  if (!rows.length) return null;
  const superseded = new Set(rows.map((r) => r.supersedes).filter(Boolean) as string[]);
  const cur = rows.find((r) => !superseded.has(r.id)) ?? rows[rows.length - 1];
  return cur?.object_text ?? null;
}

async function pickTarget(supabase: ReturnType<typeof createServerClient>): Promise<{ id: string; name: string; domain: string } | null> {
  const acctIds = await entityIdsOfType(supabase, WS, 'account');
  const ents = await supabase.from('entities').select('id, name, attributes').in('id', acctIds.slice(0, 150));
  const rows = ((ents.data ?? []) as Array<{ id: string; name: string; attributes: { domain?: string } | null }>)
    .map((e) => ({ id: e.id, name: e.name, domain: (e.attributes?.domain ?? '').toLowerCase() }))
    .filter((e) => e.domain && !e.domain.endsWith('.example'));

  if (nameArg) {
    const hit = rows.find((e) => e.name.toLowerCase().includes(nameArg.toLowerCase()));
    return hit ?? null;
  }
  // Highest current score_total wins.
  const scoreF = await supabase.from('facts').select('subject_entity, id, object_text, supersedes')
    .eq('workspace_id', WS).eq('predicate', 'score_total').in('subject_entity', rows.map((r) => r.id));
  const byEnt = new Map<string, Array<{ id: string; object_text: string | null; supersedes: string | null }>>();
  for (const f of (scoreF.data ?? []) as Array<{ subject_entity: string; id: string; object_text: string | null; supersedes: string | null }>) {
    if (!byEnt.has(f.subject_entity)) byEnt.set(f.subject_entity, []);
    byEnt.get(f.subject_entity)!.push(f);
  }
  let best: { id: string; name: string; domain: string } | null = null;
  let bestScore = -1;
  for (const e of rows) {
    const v = parseFloat(currentValue(byEnt.get(e.id) ?? []) ?? '');
    if (Number.isFinite(v) && v > bestScore) { bestScore = v; best = e; }
  }
  if (best) console.log(`Top account by score_total = ${bestScore.toFixed(2)}`);
  return best ?? rows[0] ?? null;
}

async function main() {
  const supabase = createServerClient();
  const target = await pickTarget(supabase);
  if (!target) { console.error('no eligible account found'); process.exit(1); }
  console.log(`\nQualifying: ${target.name} (${target.domain})  id=${target.id}\n`);

  const t0 = Date.now();
  const startedAt = new Date(t0 - 1000).toISOString();
  const res = await runQualification(supabase, { workspace_id: WS, entity_id: target.id });
  console.log(`\n=== RESULT (${((Date.now() - t0) / 1000).toFixed(0)}s) ===`);
  console.log(JSON.stringify(res, null, 2));

  // Step trail.
  const ev = await supabase.from('events')
    .select('action, payload, created_at')
    .eq('workspace_id', WS).eq('target_id', target.id)
    .in('action', ['qualification_started', 'qualification_step', 'qualification_finished'])
    .gte('created_at', startedAt)
    .order('created_at', { ascending: true });
  console.log(`\n=== STEP TRAIL (${(ev.data ?? []).length} events) ===`);
  for (const e of (ev.data ?? []) as Array<{ action: string; payload: any }>) {
    if (e.action === 'qualification_step') {
      const calls = (e.payload?.tool_calls ?? []).map((c: any) => `${c.name}(${JSON.stringify(c.args).slice(0, 80)})`).join(', ');
      console.log(`  step ${e.payload?.step}: ${calls || '(text only)'}  [${e.payload?.tokens?.input ?? 0}in/${e.payload?.tokens?.output ?? 0}out]`);
    } else {
      console.log(`  ${e.action}: ${JSON.stringify(e.payload).slice(0, 160)}`);
    }
  }

  // Facts asserted in this window.
  const factsSince = await supabase.from('facts')
    .select('predicate, object_text, confidence, created_at')
    .eq('workspace_id', WS).eq('subject_entity', target.id)
    .gte('created_at', startedAt)
    .order('created_at', { ascending: true });
  console.log(`\n=== FACTS ASSERTED THIS RUN (${(factsSince.data ?? []).length}) ===`);
  for (const f of (factsSince.data ?? []) as Array<{ predicate: string; object_text: string | null; confidence: number }>) {
    console.log(`  ${f.predicate} = ${(f.object_text ?? '').slice(0, 90)}  (${f.confidence})`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
