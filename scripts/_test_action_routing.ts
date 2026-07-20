import { selectAction, DEFAULT_THRESHOLDS, type ScoreBreakdown } from '@agent-crm/tools';

// Synthetic, no DB. Proves the gate the handoff rebuilt: a strong-fit account
// with NO contact must route to enrich_contacts (not draft, not watch), and a
// strong-fit account WITH a good contact must reach draft_outreach.
const strongBreakdown: ScoreBreakdown = {
  industry_match: 0.9, stage_match: 0.8, signal_strength: 0.8,
  evidence_depth: 0.8, recency: 0.8, graph_proximity: 0.5, rrf_prefilter: 0.6,
};

const base = {
  workspace_id: 'w', entity_id: 'e', breakdown: strongBreakdown, icp_total: 0.8,
  recent_draft_at: null, recent_research_at: null, recent_contacts_request_at: null,
  dropped_until: null, cooldown_until: null, thresholds: DEFAULT_THRESHOLDS,
};

const cases: Array<{ name: string; args: any; expect: string }> = [
  { name: 'strong account, NO contact (undefined)', args: { ...base, best_contact_score: undefined }, expect: 'enrich_contacts' },
  { name: 'strong account, weak contact (0.3)',     args: { ...base, best_contact_score: 0.3 },       expect: 'enrich_contacts' },
  { name: 'strong account, good contact (0.7)',     args: { ...base, best_contact_score: 0.7 },       expect: 'draft_outreach' },
  { name: 'strong account, no contact, in cooldown',args: { ...base, best_contact_score: undefined, recent_contacts_request_at: new Date(Date.now() - 1*86400_000).toISOString() }, expect: 'watch_only' },
  { name: 'mid account (0.55), no contact',          args: { ...base, icp_total: 0.55, best_contact_score: undefined }, expect: 'watch_only' },
  { name: 'weak account (0.4), no contact',          args: { ...base, icp_total: 0.4, best_contact_score: undefined }, expect: 'continue' },
  { name: 'off-icp account (0.2), no contact',       args: { ...base, icp_total: 0.2, best_contact_score: undefined }, expect: 'drop' },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const d = selectAction(c.args);
  const ok = d.action === c.expect;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}\n      → ${d.action} [${d.policy}] (expected ${c.expect})`);
  if (!ok) { console.log(`      reason: ${d.reason}`); fail++; } else pass++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
