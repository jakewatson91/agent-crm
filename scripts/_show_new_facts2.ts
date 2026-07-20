import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const { data } = await sb.from('events')
    .select('created_at, actor_id, action, payload, target_id')
    .eq('workspace_id', WS)
    .in('action', ['assert_fact', 'supersede_fact'])
    .in('actor_id', ['default_enricher', 'relevant_hires_enricher'])
    .gte('created_at', '2026-07-14T01:45:00Z')
    .order('created_at', { ascending: true });
  const names = new Map<string, string>();
  for (const e of data ?? []) {
    const p = (e.payload as { args?: { subject_entity?: string; predicate?: string; object_text?: string } } | null)?.args ?? {};
    const subj = p.subject_entity ?? '';
    if (subj && !names.has(subj)) {
      const { data: ent } = await sb.from('entities').select('name').eq('id', subj).single();
      names.set(subj, ent?.name ?? '?');
    }
    console.log(`[${names.get(subj) ?? '?'}] ${p.predicate} = ${(p.object_text ?? '').slice(0, 140)}`);
  }
  console.log(`total events: ${data?.length ?? 0}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
