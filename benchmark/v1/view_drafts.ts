/**
 * Eyeball viewer for v1 drafts/briefs/scores.
 *
 * Reads results/runs.jsonl and prints same-account drafts grouped by workload,
 * so you can compare agent-crm vs hubspot vs Day.ai output quality at a glance.
 *
 * Usage:
 *   tsx benchmark/v1/view_drafts.ts                    # all workloads, all accounts, run 1 each
 *   tsx benchmark/v1/view_drafts.ts draft              # just drafts
 *   tsx benchmark/v1/view_drafts.ts brief Ramp         # just brief workload, just Ramp
 *   tsx benchmark/v1/view_drafts.ts score 11x.ai 2     # specific workload+account+run
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_PATH = resolve(__dirname, 'results/runs.jsonl');

interface Row {
  workload: string;
  platform: string;
  shape: string;
  account: string;
  run: number;
  draft: string | null;
  ok: boolean;
  input_tokens: number;
  output_tokens: number;
}

const args = process.argv.slice(2);
const filterWorkload = args[0]; // 'draft' | 'brief' | 'score' | undefined
const filterAccount = args[1];
const filterRun = args[2] ? Number(args[2]) : 1;

const rows = readFileSync(RUNS_PATH, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) as Row[];

const workloads = filterWorkload ? [filterWorkload] : ['draft', 'brief', 'score'];
const accounts = filterAccount ? [filterAccount] : ['11x.ai', 'Sendbird', 'Trigify.io', 'Ramp', 'Netic', 'Explorium'];
// For comparison, pick canonical shape per platform:
//  - agent-crm: projection (only one)
//  - hubspot:   tight (best-effort)
//  - dayai:     tight (best-effort)
const canonicalShape = (platform: string) =>
  platform === 'agent-crm' ? 'projection' : 'tight';

const sep = '═'.repeat(80);
const sub = '─'.repeat(80);

for (const workload of workloads) {
  console.log(`\n${sep}\n  WORKLOAD: ${workload.toUpperCase()}\n${sep}`);
  for (const account of accounts) {
    console.log(`\n${sub}`);
    console.log(`  ACCOUNT: ${account} (run ${filterRun})`);
    console.log(sub);
    for (const platform of ['agent-crm', 'hubspot', 'dayai']) {
      const r = rows.find(
        (x) => x.workload === workload && x.account === account && x.run === filterRun
          && x.platform === platform && x.shape === canonicalShape(platform),
      );
      if (!r) { console.log(`\n  [${platform}/${canonicalShape(platform)}] NOT FOUND`); continue; }
      console.log(`\n  [${platform}/${r.shape}] ${r.input_tokens}in / ${r.output_tokens}out ${r.ok ? '✓' : '✗'}`);
      console.log();
      if (r.draft) {
        // Try to pretty-print JSON drafts
        try {
          const stripped = r.draft.replace(/^```(?:json)?\n?/, '').replace(/\n?```\s*$/, '');
          const j = JSON.parse(stripped);
          console.log(JSON.stringify(j, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
        } catch {
          console.log('    ' + r.draft.split('\n').join('\n    '));
        }
      } else {
        console.log('    (no draft)');
      }
    }
  }
}
