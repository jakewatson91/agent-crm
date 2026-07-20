import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  for (const name of ['CBC/Radio-Canada', 'Videotron/Quebecor', 'ClipFix']) {
    const { data: ent } = await sb.from('entities').select('id').eq('workspace_id', WS).eq('name', name).limit(1).single();
    const { data } = await sb.from('facts').select('id, predicate, object_text, observed_at, supersedes')
      .eq('workspace_id', WS).eq('subject_entity', ent!.id)
      .in('predicate', ['score_total', 'score_signal_strength', 'score_evidence_depth']);
    const pointed = new Set((data ?? []).map((r) => r.supersedes).filter(Boolean));
    const cur = (data ?? []).filter((r) => !pointed.has(r.id));
    const fmt = (p: string) => { const f = cur.find((r) => r.predicate === p); return f ? `${f.object_text}@${f.observed_at.slice(5, 16)}` : '-'; };
    console.log(`${name}: total=${fmt('score_total')}  signal=${fmt('score_signal_strength')}  evidence=${fmt('score_evidence_depth')}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
