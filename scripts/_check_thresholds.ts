import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await sb.from('workspaces').select('id').like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  const WS = ws.data!.id as string;

  const rows = await sb.from('facts').select('subject_entity, object_text')
    .eq('workspace_id', WS).eq('predicate', 'icp_fit').is('supersedes', null);
  const scores = ((rows.data ?? []) as Array<{ subject_entity: string; object_text: string }>)
    .map((r) => ({ id: r.subject_entity, v: parseFloat(r.object_text) }))
    .filter((s) => Number.isFinite(s.v));

  const draft = scores.filter((s) => s.v >= 0.65);
  const watch = scores.filter((s) => s.v >= 0.5 && s.v < 0.65);
  const drop  = scores.filter((s) => s.v < 0.35);
  const mid   = scores.filter((s) => s.v >= 0.35 && s.v < 0.5);

  console.log(`scored: ${scores.length}\n`);
  console.log(`DRAFT  (>= 0.65) : ${draft.length}  ← would trigger outreach + a gate`);
  console.log(`WATCH  (0.5-0.65): ${watch.length}  ← agent keeps watching, no outreach`);
  console.log(`MID    (0.35-0.5): ${mid.length}  ← no action`);
  console.log(`DROP   (< 0.35)  : ${drop.length}  ← agent drops`);

  // Show the top scorers + their names
  const top = scores.sort((a, b) => b.v - a.v).slice(0, 10);
  const ents = await sb.from('entities').select('id, name').in('id', top.map((t) => t.id));
  const nameById = new Map((ents.data ?? []).map((e: any) => [e.id, e.name]));
  console.log(`\ntop 10 scorers:`);
  for (const t of top) console.log(`  ${t.v.toFixed(2)}  ${nameById.get(t.id) ?? t.id}`);
}
main();
