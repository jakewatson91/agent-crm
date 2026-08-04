/**
 * Read-only: show the last two icp_fit_breakdown facts for an account so a score
 * move can be attributed to a specific dimension rather than guessed at.
 * Usage: tsx scripts/_chk_score_delta.ts "Pocket FM"
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const NAME = process.argv[2] ?? 'Pocket FM';

async function main() {
  const { data: ents } = await sb.from('entities').select('id, name').eq('workspace_id', WS).ilike('name', `%${NAME}%`).limit(1);
  const ent = (ents ?? [])[0] as { id: string; name: string } | undefined;
  if (!ent) throw new Error(`no entity matching ${NAME}`);
  const { data } = await sb.from('facts')
    .select('object_text, observed_at, created_at')
    .eq('workspace_id', WS).eq('subject_entity', ent.id).eq('predicate', 'icp_fit_breakdown')
    .order('created_at', { ascending: false }).limit(2);
  const rows = (data ?? []) as Array<{ object_text: string; created_at: string }>;
  console.log(`=== ${ent.name} ===`);
  const dims = ['industry_match', 'stage_match', 'signal_strength', 'evidence_depth', 'recency', 'graph_proximity'];
  const parsed = rows.map((r) => ({ at: r.created_at, o: JSON.parse(r.object_text) as Record<string, unknown> }));
  if (parsed.length < 2) { console.log('only one breakdown on file'); console.log(JSON.stringify(parsed[0]?.o, null, 2)); return; }
  const [now, before] = parsed;
  console.log(`after : ${now.at}`);
  console.log(`before: ${before.at}\n`);
  console.log('dimension          before   after   delta');
  for (const d of dims) {
    const b = Number(before.o[d]); const a = Number(now.o[d]);
    const mark = Math.abs(a - b) >= 0.15 ? '  <<<' : '';
    console.log(`${d.padEnd(18)} ${b.toFixed(2).padStart(5)}   ${a.toFixed(2).padStart(5)}   ${(a - b >= 0 ? '+' : '')}${(a - b).toFixed(2)}${mark}`);
  }
  console.log(`\nunknown_dims before: ${JSON.stringify(before.o.unknown_dims ?? [])}`);
  console.log(`unknown_dims after : ${JSON.stringify(now.o.unknown_dims ?? [])}`);
  console.log(`out_of_scope after : ${now.o.out_of_scope ?? '(none)'}`);
  console.log(`\nreasoning before: ${String(before.o.reasoning ?? '').slice(0, 400)}`);
  console.log(`\nreasoning after : ${String(now.o.reasoning ?? '').slice(0, 400)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
