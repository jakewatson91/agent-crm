import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
(async () => {
  // do repeated contacts_requested for the same subject ever produce multiple supersedes-null rows,
  // or does assert_fact chain them? Inspect the one account that has requests.
  const { data } = await db.from('facts').select('subject_entity, supersedes, created_at, object_text')
    .eq('workspace_id', ws).eq('predicate', 'contacts_requested').order('created_at', { ascending: true });
  const bySubj: Record<string, any[]> = {};
  for (const r of (data ?? []) as any[]) (bySubj[r.subject_entity] ??= []).push(r);
  for (const [s, rows] of Object.entries(bySubj)) {
    const nulls = rows.filter((r) => !r.supersedes).length;
    console.log(`subj=${s.slice(0,8)} total_rows=${rows.length} supersedes_null=${nulls}`);
  }
})();
