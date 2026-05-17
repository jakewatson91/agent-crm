/**
 * Demo the score_facts shortlist for one account. Shows the ranking, the
 * scores, and the one-line "why" each fact got picked.
 *
 * Usage: pnpm exec tsx scripts/demo_shortlist.ts "Forge Robotics"
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreFacts } from '@agent-crm/tools';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const ACCOUNT = process.argv[2] || 'Forge Robotics';

async function main() {
  const ws = await supabase.from('workspaces').select('id').like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  const wsId = ws.data!.id as string;
  const ent = await supabase.from('entities').select('id, name').eq('workspace_id', wsId).eq('kind', 'account').eq('name', ACCOUNT).single();
  const accountId = ent.data!.id as string;

  const all = await supabase.from('facts')
    .select('id, predicate, object_text, confidence, supersedes, observed_at, source_event_id')
    .eq('workspace_id', wsId).eq('subject_entity', accountId);
  const supSet = new Set((all.data ?? []).map((f) => f.supersedes as string | null).filter((x): x is string => !!x));
  const active = (all.data ?? []).filter((f) => !supSet.has(f.id as string));

  console.log(`\nAccount: ${ACCOUNT}  (${active.length} active facts)\n`);

  const t0 = Date.now();
  const shortlist = await scoreFacts(supabase, {
    workspace_id: wsId,
    account_entity_id: accountId,
    facts: active.map((f: any) => ({
      id: f.id, predicate: f.predicate, object_text: f.object_text,
      confidence: f.confidence, observed_at: f.observed_at, source_event_id: f.source_event_id,
    })),
  });
  const elapsed = Date.now() - t0;

  console.log(`Top-${shortlist.length} shortlist (${elapsed}ms to compute):\n`);
  for (const r of shortlist) {
    const f = active.find((x) => x.id === r.id);
    console.log(`  score=${r.score.toFixed(3)}  ${f?.predicate}=${f?.object_text}`);
    console.log(`    why: ${r.why}`);
    console.log(`    components: pitch=${r.components.pitch_relevance.toFixed(2)} recency=${r.components.recency.toFixed(2)} conf=${r.components.confidence.toFixed(2)} over_used=${r.components.over_used.toFixed(2)} outcome_boost=${r.components.outcome_boost.toFixed(2)}`);
    console.log('');
  }

  console.log(`All ${active.length} facts (for reference):`);
  for (const f of active) {
    console.log(`  ${f.id.slice(0, 8)}  ${f.predicate}=${(f.object_text ?? '').slice(0, 60)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
