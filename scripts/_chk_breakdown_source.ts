import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { breakdownFromFacts } from '@agent-crm/tools';

/**
 * After 7fd71bc stopped writing four of the six score dimensions as their own
 * fact rows, and the rows already written were deleted, every caller that wants
 * a dimension has to be reading the icp_fit_breakdown JSON. This walks live
 * scored accounts and reports which source each one resolves to. A 'score_facts'
 * answer means that entity has no breakdown fact and four of its six dimensions
 * would read as 0.
 */
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  for (const name of ['Sudden', 'demo · agent-crm']) {
    const ws = await sb.from('workspaces').select('id').eq('name', name).maybeSingle();
    if (!ws.data) continue;
    // Sample entities the scorer has actually run on, by their icp_fit fact.
    const scored = await sb.from('facts').select('subject_entity').eq('workspace_id', ws.data.id).eq('predicate', 'icp_fit').limit(40);
    const ids = [...new Set(((scored.data ?? []) as Array<{ subject_entity: string }>).map((r) => r.subject_entity))];
    const ents = await sb.from('entities').select('id, name').in('id', ids);
    const counts = { breakdown: 0, score_facts: 0, none: 0 };
    const examples: string[] = [];
    for (const e of (ents.data ?? []) as Array<{ id: string; name: string }>) {
      const f = await sb.from('facts').select('id, predicate, object_text, supersedes').eq('subject_entity', e.id);
      const rows = (f.data ?? []) as Array<{ id: string; predicate: string; object_text: string | null; supersedes: string | null }>;
      const superseded = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
      const active = rows.filter((r) => !superseded.has(r.id));
      const r = breakdownFromFacts(active);
      if (!r) { counts.none++; continue; }
      counts[r.source]++;
      if (r.source === 'breakdown' && examples.length < 2) {
        const b = r.breakdown;
        examples.push(`${e.name}: industry ${b.industry_match.toFixed(2)} stage ${b.stage_match.toFixed(2)} signal ${b.signal_strength.toFixed(2)} evidence ${b.evidence_depth.toFixed(2)} recency ${b.recency.toFixed(2)} graph ${b.graph_proximity.toFixed(2)}`);
      }
      if (r.source === 'score_facts' && examples.length < 4) examples.push(`${e.name}: NO BREAKDOWN FACT, four dimensions read 0`);
    }
    console.log(`${name}: breakdown=${counts.breakdown} score_facts=${counts.score_facts} unscored=${counts.none}`);
    examples.forEach((x) => console.log('   ', x));
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
