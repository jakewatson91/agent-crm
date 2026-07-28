import { selectAction, DEFAULT_THRESHOLDS } from '@agent-crm/tools';

// The typical Sudden account: 5 CSV import facts, no research, no contact.
const csvOnly = {
  industry_match: 1.0, stage_match: 0.4, signal_strength: 0.4,
  evidence_depth: 0.83, recency: 0.99, graph_proximity: 0, rrf_prefilter: 0,
};
// Same account after research found a real trigger.
const researched = { ...csvOnly, signal_strength: 1.0, evidence_depth: 1.0 };

const base = {
  workspace_id: 'w', entity_id: 'e',
  recent_draft_at: null, recent_research_at: null,
  recent_contacts_request_at: null, dropped_until: null, cooldown_until: null,
};

const cases: Array<[string, any]> = [
  ['CSV-only, never researched, no contact          ', { ...base, breakdown: csvOnly, icp_total: 0.68 }],
  ['CSV-only, researched 30d ago, no contact        ', { ...base, breakdown: csvOnly, icp_total: 0.68, recent_research_at: new Date(Date.now() - 30 * 864e5).toISOString() }],
  ['CSV-only, researched 2d ago, no contact         ', { ...base, breakdown: csvOnly, icp_total: 0.68, recent_research_at: new Date(Date.now() - 2 * 864e5).toISOString() }],
  ['researched 2d ago, has good contact, hot signal ', { ...base, breakdown: researched, icp_total: 0.78, best_contact_score: 0.75, recent_research_at: new Date(Date.now() - 2 * 864e5).toISOString() }],
  ['low fit 0.30, plenty of evidence                ', { ...base, breakdown: { ...csvOnly, industry_match: 0 }, icp_total: 0.30 }],
  ['below research bar 0.45, never researched       ', { ...base, breakdown: csvOnly, icp_total: 0.45 }],
  ['researched, HOT signal, no contact              ', { ...base, breakdown: researched, icp_total: 0.78, recent_research_at: new Date(Date.now() - 2 * 864e5).toISOString() }],
  ['researched 30d ago, weak signal, no contact     ', { ...base, breakdown: csvOnly, icp_total: 0.68, recent_research_at: new Date(Date.now() - 30 * 864e5).toISOString() }],
];

console.log('thresholds:', JSON.stringify(DEFAULT_THRESHOLDS));
console.log();
for (const [name, args] of cases) {
  const d = selectAction(args);
  console.log(`${name} -> ${d.action.padEnd(16)} [${d.policy}]`);
  console.log(`    ${d.reason}`);
}
