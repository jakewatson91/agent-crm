/**
 * Twenty benchmark runner.
 *
 * 6 accounts × 3 runs × 3 workloads × 2 shapes = 108 runs.
 * Appends to results/runs.jsonl + regenerates summary.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TWENTY_TOOLS, execTwentyTool, type TwentyShape } from './readers/twenty.js';
import { callDeepSeek, V1_MODEL, type ChatMessage } from './lib/llm.js';
import { saveReceipt } from './lib/receipts.js';
import { WORKLOADS, type WorkloadName, type Workload } from './lib/workloads.js';
import { summarize, type RunRow as SummaryRunRow } from './lib/summary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(__dirname, 'results');
const RUNS_PATH = resolve(RESULTS_DIR, 'runs.jsonl');

const ACCOUNTS = ['11x.ai', 'Sendbird', 'Trigify.io', 'Ramp', 'Netic', 'Explorium'];
const RUNS_PER_ACCOUNT = 3;
const TWENTY_SHAPES: TwentyShape[] = ['default', 'tight'];
const WORKLOAD_NAMES: WorkloadName[] = ['draft', 'brief', 'score'];

interface RunRow {
  workload: WorkloadName;
  platform: 'twenty';
  shape: TwentyShape;
  account: string;
  run: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  llm_calls: number;
  api_calls_to_data_store: number;
  total_latency_ms: number;
  draft: string | null;
  ok: boolean;
  error?: string;
}

async function runTwenty(workload: Workload, account: string, run: number, shape: TwentyShape): Promise<RunRow> {
  try {
    const tStart = Date.now();
    const messages: ChatMessage[] = [
      { role: 'system', content: workload.systemPromptTwenty },
      { role: 'user', content: workload.userPromptTwenty(account) },
    ];
    let totalInput = 0, totalOutput = 0, llmCalls = 0, dataCalls = 0;
    const MAX_TURNS = 12;
    let finalContent: string | null = null;

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      const llm = await callDeepSeek(messages, TWENTY_TOOLS);
      llmCalls++;
      totalInput += llm.input_tokens;
      totalOutput += llm.output_tokens;
      saveReceipt({ platform: 'agent-crm', account, run, stage: `twenty_${workload.name}_${shape}_turn${turn}_llm`, model: V1_MODEL }, {
        workload: workload.name, shape, platform: 'twenty',
        request_messages: messages, response: llm.response_body,
        content: llm.content, tool_calls: llm.tool_calls,
        input_tokens: llm.input_tokens, output_tokens: llm.output_tokens, latency_ms: llm.latency_ms,
      });

      const assistantMsg: ChatMessage = {
        role: 'assistant', content: llm.content,
        tool_calls: llm.tool_calls.length
          ? llm.tool_calls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments_json } }))
          : undefined,
      };
      messages.push(assistantMsg);

      if (llm.tool_calls.length === 0) { finalContent = llm.content; break; }

      for (const tc of llm.tool_calls) {
        let args: Record<string, unknown>;
        try { args = JSON.parse(tc.arguments_json); } catch { args = {}; }
        const apiCall = await execTwentyTool(tc.name, args, shape);
        dataCalls++;
        saveReceipt({ platform: 'agent-crm', account, run, stage: `twenty_${workload.name}_${shape}_turn${turn}_tool_${tc.name}` }, { workload: workload.name, shape, platform: 'twenty', ...apiCall });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(apiCall.response.body) });
      }
    }

    return {
      workload: workload.name, platform: 'twenty', shape, account, run,
      input_tokens: totalInput, output_tokens: totalOutput, total_tokens: totalInput + totalOutput,
      llm_calls: llmCalls, api_calls_to_data_store: dataCalls, total_latency_ms: Date.now() - tStart,
      draft: finalContent, ok: !!finalContent,
      error: finalContent ? undefined : 'no final content (max turns)',
    };
  } catch (e) {
    return {
      workload: workload.name, platform: 'twenty', shape, account, run,
      input_tokens: 0, output_tokens: 0, total_tokens: 0,
      llm_calls: 0, api_calls_to_data_store: 0, total_latency_ms: 0,
      draft: null, ok: false, error: (e as Error).message,
    };
  }
}

async function main() {
  console.log('Twenty benchmark');
  console.log(`model: ${V1_MODEL}`);
  console.log(`accounts: ${ACCOUNTS.length}, shapes: ${TWENTY_SHAPES.join(', ')}, workloads: ${WORKLOAD_NAMES.join(', ')}\n`);

  mkdirSync(RESULTS_DIR, { recursive: true });

  const newRows: RunRow[] = [];
  for (const workloadName of WORKLOAD_NAMES) {
    const workload = WORKLOADS[workloadName];
    console.log(`\n========== workload: ${workloadName} ==========`);
    for (const account of ACCOUNTS) {
      for (let run = 1; run <= RUNS_PER_ACCOUNT; run++) {
        for (const shape of TWENTY_SHAPES) {
          const r = await runTwenty(workload, account, run, shape);
          newRows.push(r);
          appendFileSync(RUNS_PATH, JSON.stringify(r) + '\n');
          console.log(`  ${workloadName}/twenty/${shape.padEnd(7)} ${account.padEnd(14)} run ${run}: ${r.ok ? `${r.input_tokens}in / ${r.output_tokens}out / ${r.llm_calls} LLM / ${r.total_latency_ms}ms` : `FAILED: ${r.error}`}`);
        }
      }
    }
  }

  const allRows = readFileSync(RUNS_PATH, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const summary = summarize(allRows as SummaryRunRow[], ACCOUNTS, RUNS_PER_ACCOUNT);
  writeFileSync(resolve(RESULTS_DIR, 'summary.md'), summary);
  console.log(`\n--- New Twenty rows: ${newRows.length} (${newRows.filter((r) => r.ok).length} ok, ${newRows.filter((r) => !r.ok).length} failed) ---`);
}

main().catch((e) => { console.error(e); process.exit(1); });
