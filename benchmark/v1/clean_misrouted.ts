import { readFileSync, writeFileSync } from 'node:fs';
const RUNS = '/Users/jakewatson/src/agent-crm/benchmark/v1/results/runs.jsonl';
const rows = readFileSync(RUNS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const isValid = (r: any) =>
  (r.platform === 'agent-crm' && r.shape === 'projection') ||
  (r.platform === 'hubspot' && ['naive', 'current', 'tight'].includes(r.shape)) ||
  (r.platform === 'dayai' && ['default', 'tight'].includes(r.shape));
const before = rows.length;
const cleaned = rows.filter(isValid);
writeFileSync(RUNS, cleaned.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`Removed ${before - cleaned.length} misrouted rows. Kept ${cleaned.length}.`);
