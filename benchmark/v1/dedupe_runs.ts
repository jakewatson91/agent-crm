import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUNS = '/Users/jakewatson/src/agent-crm/benchmark/v1/results/runs.jsonl';
const lines = readFileSync(RUNS, 'utf8').split('\n').filter(Boolean);
const rows = lines.map((l) => JSON.parse(l));

// Dedupe: keep the LATEST row per (workload, platform, shape, account, run).
// "Latest" = appears later in the file. If a later one is ok, keep it; if a later
// one is failed but an earlier one is ok, keep the ok one.
const map = new Map<string, any>();
for (const r of rows) {
  const key = `${r.workload}|${r.platform}|${r.shape}|${r.account}|${r.run}`;
  const existing = map.get(key);
  if (!existing) { map.set(key, r); continue; }
  // Prefer ok over not-ok. If both ok or both not-ok, prefer the later one.
  if (r.ok && !existing.ok) map.set(key, r);
  else if (r.ok === existing.ok) map.set(key, r); // later wins
}
const out = Array.from(map.values());
out.sort((a, b) => {
  if (a.workload !== b.workload) return a.workload.localeCompare(b.workload);
  if (a.account !== b.account) return a.account.localeCompare(b.account);
  if (a.run !== b.run) return a.run - b.run;
  if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
  return String(a.shape).localeCompare(String(b.shape));
});
writeFileSync(RUNS, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
const ok = out.filter((r) => r.ok).length;
console.log(`Before: ${rows.length} rows, ${new Set(rows.map((r) => `${r.workload}|${r.platform}|${r.shape}|${r.account}|${r.run}`)).size} unique keys`);
console.log(`After dedupe: ${out.length} rows (${ok} ok, ${out.length - ok} failed)`);
