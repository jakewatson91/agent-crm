import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;

  // find Scheduling Wizard
  const ent = (await sb.from('entities').select('id, name').eq('workspace_id', ws).ilike('name', 'Scheduling Wizard').limit(1)).data?.[0] as any;
  console.log('subject:', ent?.name, ent?.id?.slice(0, 8));

  // all score_signal_strength facts for it, full detail, ordered by created_at
  const rows = (await sb.from('facts')
    .select('id, object_text, supersedes, observed_at, created_at')
    .eq('workspace_id', ws).eq('subject_entity', ent.id).eq('predicate', 'score_signal_strength')
    .order('created_at', { ascending: true })).data ?? [];
  console.log(`\nALL score_signal_strength facts (${rows.length}):`);
  for (const r of rows as any[]) {
    console.log(`  id=${r.id.slice(0,8)} value=${r.object_text} supersedes=${r.supersedes ? r.supersedes.slice(0,8) : 'NULL'} created=${r.created_at}`);
  }

  // which one does the "active" filter (.is supersedes null) return?
  const active = (await sb.from('facts')
    .select('id, object_text, created_at')
    .eq('workspace_id', ws).eq('subject_entity', ent.id).eq('predicate', 'score_signal_strength')
    .is('supersedes', null)).data ?? [];
  console.log(`\nwhat ".is(supersedes, null)" (code's ACTIVE filter) returns:`);
  for (const r of active as any[]) console.log(`  id=${r.id.slice(0,8)} value=${r.object_text} created=${r.created_at}`);

  // sanity: is there any fact pointing AT the supersedes-null one? (reverse direction check)
  if (active[0]) {
    const pointingAt = (await sb.from('facts').select('id, object_text, created_at').eq('supersedes', (active[0] as any).id)).data ?? [];
    console.log(`\nfacts whose supersedes -> the active one (${(active[0] as any).id.slice(0,8)}): ${pointingAt.length}`);
    for (const r of pointingAt as any[]) console.log(`  id=${r.id.slice(0,8)} value=${r.object_text} created=${r.created_at}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
