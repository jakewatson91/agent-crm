import { config } from 'dotenv';
config({ path: '.env.local' });
import { selectAction, buildThresholds } from '@agent-crm/tools';

const breakdown = { industry_match: 0.8, stage_match: 0.7, signal_strength: 0.4, evidence_depth: 0.6, recency: 0.9, graph_proximity: 0.5, rrf_prefilter: 0 };
const base = { workspace_id: 'w', entity_id: 'e', breakdown, icp_total: 0.72, best_contact_score: 0.38, recent_draft_at: null, recent_research_at: null, dropped_until: null, cooldown_until: null, facts: [], value_themes: [], thresholds: buildThresholds(undefined) };
const now = Date.now();
const cases = [
  { label: 'no prior request', at: null },
  { label: 'requested just now (cooldown active)', at: new Date(now).toISOString() },
  { label: 'requested 1 day ago (still cooling)', at: new Date(now - 1 * 86400000).toISOString() },
  { label: 'requested 5 days ago (window passed)', at: new Date(now - 5 * 86400000).toISOString() },
];
for (const c of cases) {
  const d = selectAction({ ...base, recent_contacts_request_at: c.at } as any);
  console.log(`${c.label.padEnd(40)} -> ${d.action}`);
}
