import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  // top-scored accounts among those with a domain set
  const PAGE = 1000;
  const domained: Array<{ id: string; name: string }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await sb.from('entities').select('id, name, attributes').eq('workspace_id', WS).range(from, from + PAGE - 1);
    for (const e of data ?? []) {
      const d = (e.attributes as Record<string, unknown> | null)?.domain;
      if (typeof d === 'string' && d.length) domained.push({ id: e.id, name: e.name });
    }
    if ((data ?? []).length < PAGE) break;
  }
  const { data: scores } = await sb.from('facts')
    .select('subject_entity, object_text, supersedes, id')
    .eq('workspace_id', WS).eq('predicate', 'score_total')
    .in('subject_entity', domained.map((d) => d.id));
  const pointed = new Set((scores ?? []).map((r) => r.supersedes).filter(Boolean));
  const scoreById = new Map<string, number>();
  for (const r of scores ?? []) {
    if (pointed.has(r.id)) continue;
    scoreById.set(r.subject_entity, parseFloat(r.object_text ?? '0'));
  }
  const top = domained
    .map((d) => ({ ...d, score: scoreById.get(d.id) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const key = process.env.INNGEST_EVENT_KEY!;
  for (const t of top) {
    const res = await fetch(`https://inn.gs/e/${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'research.requested',
        data: {
          workspace_id: WS, entity_id: t.id, entity_name: t.name,
          reason: 'manual:exa-topup-verify', tier: 'hot', angle_count: 5,
        },
      }),
    });
    console.log(`sent research.requested → ${t.name} (score ${t.score.toFixed(2)}): ${res.status}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
