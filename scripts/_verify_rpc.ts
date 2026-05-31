import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { embed, vectorLiteral } from '@agent-crm/primitives';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  const sw = (await sb.from('entities').select('id').eq('workspace_id', ws).ilike('name', 'Scheduling Wizard').limit(1)).data?.[0] as { id: string };

  const vec = vectorLiteral(await embed('Scheduling Wizard healthcare scheduling logistics operations'));
  const { data, error } = await sb.rpc('query_facts_by_similarity', { p_workspace_id: ws, p_query_embedding: vec, p_top_k: 150, p_perspective: null });
  if (error) throw error;
  const rows = (data ?? []) as Array<{ fact_id: string; subject_entity: string; predicate: string; object_text: string }>;

  // discriminating: when SW's score_signal_strength surfaces, fixed RPC returns 0.40 (latest), buggy returned 0.70
  const swScore = rows.filter((r) => r.subject_entity === sw?.id && r.predicate === 'score_signal_strength');
  console.log(`RPC returned ${rows.length} facts`);
  console.log(`SW score_signal_strength in results: ${swScore.map((r) => r.object_text).join(', ') || '(not in top-150)'}  (fixed=0.40, buggy=0.70)`);

  // invariant: no returned fact is itself superseded by a newer one
  const sup = (await sb.from('facts').select('supersedes').eq('workspace_id', ws).in('supersedes', rows.map((r) => r.fact_id))).data ?? [];
  console.log(`superseded-originals returned: ${sup.length}  (PASS if 0)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
