import { readFileSync } from 'node:fs';
const rows = readFileSync('benchmark/v1/results/runs.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

interface Stat { total: number; cleanJson: number; needsStrip: number; broken: number; }
const by: Record<string, Stat> = {};

for (const r of rows) {
  const k = `${r.platform}/${r.shape}`;
  by[k] ??= { total: 0, cleanJson: 0, needsStrip: 0, broken: 0 };
  by[k].total++;
  const d = r.draft;
  if (!d) { by[k].broken++; continue; }
  // Try clean JSON parse first
  try { JSON.parse(d); by[k].cleanJson++; continue; } catch {}
  // Try stripping markdown fences + preamble
  const stripped = d
    .replace(/^[\s\S]*?(?=\{)/, '') // drop everything before the first '{'
    .replace(/```\s*$/, '')
    .replace(/```json\s*\n?/g, '');
  try { JSON.parse(stripped); by[k].needsStrip++; } catch { by[k].broken++; }
}

console.log('JSON quality by platform/shape:');
console.log('platform/shape         total  cleanJSON  needsStrip  broken  %clean');
for (const [k, s] of Object.entries(by).sort()) {
  const pct = (100 * s.cleanJson / s.total).toFixed(0);
  console.log(`  ${k.padEnd(20)} ${String(s.total).padStart(5)}  ${String(s.cleanJson).padStart(9)}  ${String(s.needsStrip).padStart(10)}  ${String(s.broken).padStart(6)}  ${pct.padStart(4)}%`);
}
