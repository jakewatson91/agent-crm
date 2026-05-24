import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await sb.from('workspaces').select('id').like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  const WS = ws.data!.id as string;
  const SCORE_PREDS = ['icp_fit','icp_fit_breakdown','score_total','score_industry_match','score_stage_match','score_signal_strength','score_evidence_depth','score_recency','score_graph_proximity'];
  const got = await sb.from('facts').select('predicate', { count: 'exact', head: true }).eq('workspace_id', WS).in('predicate', SCORE_PREDS);
  console.log('scorer-output facts NOW:', got.count);
  const icp = await sb.from('facts').select('subject_entity, object_text, created_at').eq('workspace_id', WS).eq('predicate', 'icp_fit').is('supersedes', null).order('created_at', { ascending: false }).limit(5);
  console.log('latest icp_fit rows:', icp.data);
}
main();
