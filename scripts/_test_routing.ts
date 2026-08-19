import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { selectAction, buildThresholds, loadBestContactScore, loadActionContext } from '@agent-crm/tools';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, policy')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!;
  const wsId = ws.id as string;
  async function paged(pred: string) {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) { const rows = ((await sb.from('facts').select('subject_entity, object_text').eq('workspace_id', wsId).eq('predicate', pred).is('supersedes', null).range(from, from + 999)).data ?? []) as any[]; out.push(...rows); if (rows.length < 1000) break; } return out;
  }
  const acct = new Set((await paged('is_a')).filter((f) => f.object_text === 'account').map((f) => f.subject_entity));
  const st = new Map<string, number>(); for (const f of await paged('score_total')) if (acct.has(f.subject_entity)) st.set(f.subject_entity, parseFloat(f.object_text));
  const ents = new Map<string, string>();
  for (let from = 0; ; from += 1000) { const rows = ((await sb.from('entities').select('id, name').eq('workspace_id', wsId).range(from, from + 999)).data ?? []) as any[]; for (const e of rows) ents.set(e.id, e.name); if (rows.length < 1000) break; }
  const thresholds = buildThresholds((ws.policy as any)?.routing, (ws.policy as any)?.drafter?.outreach_channel);

  // top scored accounts
  const top = [...st.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  async function sub(id: string, pred: string) { const f = (await sb.from('facts').select('object_text').eq('workspace_id', wsId).eq('subject_entity', id).eq('predicate', pred).is('supersedes', null).maybeSingle()).data; return f ? parseFloat(f.object_text as string) : 0; }

  console.log('acct_icp  best_contact  ->  action            (account)');
  for (const [id, icp] of top) {
    const breakdown = {
      industry_match: await sub(id, 'score_industry_match'),
      stage_match: await sub(id, 'score_stage_match'),
      signal_strength: await sub(id, 'score_signal_strength'),
      evidence_depth: await sub(id, 'score_evidence_depth'),
      recency: await sub(id, 'score_recency'),
      graph_proximity: await sub(id, 'score_graph_proximity'),
      rrf_prefilter: 0,
    };
    const best = await loadBestContactScore(sb, wsId, id);
    const d = selectAction({ workspace_id: wsId, entity_id: id, breakdown, icp_total: icp, best_contact_score: best, recent_draft_at: null, recent_research_at: null, dropped_until: null, cooldown_until: null, facts: [], value_themes: [], thresholds });
    console.log(`  ${icp.toFixed(2)}      ${best === undefined ? ' none' : best.toFixed(2)}        ->  ${d.action.padEnd(16)}  (${ents.get(id)})`);
  }
}
main().catch((e) => { console.error('✗', e instanceof Error ? e.message : e); process.exit(1); });
