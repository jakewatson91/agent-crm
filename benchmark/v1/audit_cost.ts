/**
 * Re-derives the published v1 cost numbers from the committed runs.jsonl.
 * No API keys, no live calls, no database. This is how anyone verifies the
 * figures in WRITEUP.md: the numbers come straight from the recorded per-run
 * token counts.
 *
 *   pnpm benchmark:v1:audit
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cost, DEFAULT_PRICE } from './lib/pricing.js';
import type { RunRow } from './lib/summary.js';

const here = dirname(fileURLToPath(import.meta.url));
const RUNS_PATH = join(here, 'results', 'runs.jsonl');

// Canonical shape per platform: agent-crm uses the production text format; the
// row-based CRMs use their leanest (tight) field selection. Same comparison the
// writeup leads with.
const CANONICAL: Record<string, string> = {
  'agent-crm': 'prod-text',
  twenty: 'tight',
  hubspot: 'tight',
  dayai: 'tight',
  attio: 'tight',
};
const PLATFORM_ORDER = ['agent-crm', 'twenty', 'hubspot', 'dayai', 'attio'];
const LABEL: Record<string, string> = {
  'agent-crm': 'agent-crm',
  twenty: 'Twenty',
  hubspot: 'HubSpot',
  dayai: 'Day.ai',
  attio: 'Attio',
};
const WORKLOADS = ['draft', 'brief', 'score'] as const;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

interface Cell { n: number; input: number; output: number; calls: number; cost: number }
interface PlatformStat {
  key: string;
  label: string;
  shape: string;
  tied: boolean;
  mean_input: number;
  mean_output: number;
  mean_cost: number;
  mean_calls: number;
  ratio: number;
  workloads: Record<string, { input: number; output: number; cost: number; calls: number; n: number }>;
}

function main() {
  const rows: RunRow[] = readFileSync(RUNS_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunRow);
  const ok = rows.filter((r) => r.ok);
  const inconsistent = ok.filter((r) => r.input_tokens + r.output_tokens !== r.total_tokens).length;

  const cellOf = (platform: string, workload: string): Cell | null => {
    const shape = CANONICAL[platform];
    const rs = ok.filter((r) => r.platform === platform && r.shape === shape && r.workload === workload);
    if (!rs.length) return null;
    const input = mean(rs.map((r) => r.input_tokens));
    const output = mean(rs.map((r) => r.output_tokens));
    return { n: rs.length, input, output, calls: mean(rs.map((r) => r.llm_calls)), cost: cost(input, output) };
  };

  const statOf = (platform: string): PlatformStat | null => {
    const cells: Record<string, Cell> = {};
    for (const w of WORKLOADS) {
      const c = cellOf(platform, w);
      if (c) cells[w] = c;
    }
    const list = Object.values(cells);
    if (!list.length) return null;
    return {
      key: platform,
      label: LABEL[platform],
      shape: CANONICAL[platform],
      tied: false,
      mean_input: mean(list.map((c) => c.input)),
      mean_output: mean(list.map((c) => c.output)),
      mean_cost: mean(list.map((c) => c.cost)),
      mean_calls: mean(list.map((c) => c.calls)),
      ratio: 0,
      workloads: Object.fromEntries(
        Object.entries(cells).map(([w, c]) => [w, { input: c.input, output: c.output, cost: c.cost, calls: c.calls, n: c.n }]),
      ),
    };
  };

  const stats = PLATFORM_ORDER.map(statOf).filter((s): s is PlatformStat => s !== null);
  const ac = stats.find((s) => s.key === 'agent-crm');
  if (!ac) throw new Error('no agent-crm prod-text rows found in runs.jsonl');
  for (const s of stats) {
    s.ratio = s.mean_cost / ac.mean_cost;
    s.tied = s.key !== 'agent-crm' && s.ratio < 1.25; // within noise of us on cost
  }

  // ---- stdout ----
  console.log(`\nv1 cost audit  (source: committed benchmark/v1/results/runs.jsonl)`);
  console.log(`runs: ${rows.length} total, ${ok.length} ok, ${rows.length - ok.length} failed`);
  console.log(`token consistency (in+out == total): ${inconsistent === 0 ? 'PASS' : `FAIL on ${inconsistent} rows`}`);
  console.log(`price: $${DEFAULT_PRICE.input_per_million}/M in, $${DEFAULT_PRICE.output_per_million}/M out`);
  console.log(`       ${DEFAULT_PRICE.source}\n`);

  console.log('MEAN COST PER ACTION  (mean of draft/brief/score means, canonical shape)');
  console.log('platform     | $/action   | vs agent-crm | mean LLM calls');
  console.log('-------------|------------|--------------|---------------');
  for (const s of stats) {
    console.log(
      `${s.label.padEnd(12)} | $${s.mean_cost.toFixed(6)} | ${(s.ratio.toFixed(2) + 'x').padStart(7)}${s.tied ? ' tied' : '     '} | ${s.mean_calls.toFixed(2)}`,
    );
  }

  console.log('\nPER-WORKLOAD DETAIL');
  console.log('workload | platform   | N  | avg in | avg out | $/action   | calls');
  console.log('---------|------------|----|--------|---------|------------|------');
  for (const w of WORKLOADS) {
    for (const s of stats) {
      const c = s.workloads[w];
      if (!c) continue;
      console.log(
        `${w.padEnd(8)} | ${s.label.padEnd(10)} | ${String(c.n).padStart(2)} | ${c.input.toFixed(0).padStart(6)} | ${c.output.toFixed(0).padStart(7)} | $${c.cost.toFixed(6)} | ${c.calls.toFixed(2)}`,
      );
    }
  }

  console.log('');
}

main();
