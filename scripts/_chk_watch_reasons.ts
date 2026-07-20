// #4 verify: watch_only reasons name the actual blocker, not always signal.
import { selectAction } from '../packages/tools/src/action_selector.ts';

const base = {
  workspace_id: 'w', entity_id: 'e',
  breakdown: { industry_match: 1, stage_match: 1, signal_strength: 1, evidence_depth: 0.8, recency: 1, graph_proximity: 0, rrf_prefilter: 0.5 },
  icp_total: 0.8,
  recent_draft_at: null, recent_research_at: null,
  recent_contacts_request_at: new Date(Date.now() - 3600_000).toISOString(), // 1h ago: enrich_contacts cooldown active
  dropped_until: null, cooldown_until: null,
};

// 1. Missing contact is the real blocker (signal is 1.00)
console.log('missing contact →', selectAction({ ...base }).reason);
// 2. Weak signal is the real blocker (contact fine)
console.log('weak signal    →', selectAction({ ...base, best_contact_score: 0.9, breakdown: { ...base.breakdown, signal_strength: 0.2 } }).reason);
// 3. Suppression window is the real blocker (everything else passes)
console.log('suppression    →', selectAction({ ...base, best_contact_score: 0.9, recent_draft_at: new Date(Date.now() - 2 * 86400_000).toISOString() }).reason);
// 4. Weak contact below bar
console.log('weak contact   →', selectAction({ ...base, best_contact_score: 0.1 }).reason);
