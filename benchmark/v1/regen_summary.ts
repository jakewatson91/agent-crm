import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, type RunRow } from './lib/summary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACCOUNTS = ['11x.ai', 'Sendbird', 'Trigify.io', 'Ramp', 'Netic', 'Explorium'];
const RUNS_PATH = resolve(__dirname, 'results/runs.jsonl');
const SUMMARY_PATH = resolve(__dirname, 'results/summary.md');

const rows = readFileSync(RUNS_PATH, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) as RunRow[];
const summary = summarize(rows, ACCOUNTS, 3);
writeFileSync(SUMMARY_PATH, summary);
console.log(`wrote ${SUMMARY_PATH} (${rows.length} rows)`);
