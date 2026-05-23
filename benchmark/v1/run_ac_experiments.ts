/**
 * agent-crm architectural experiments.
 *
 * Tests two variants against the current "inline flat projection" baseline:
 *   - tree:      nest facts/contacts/signals/past_touch UNDER account (was flat siblings)
 *   - tool-call: deliver projection via a tool call response instead of in the
 *                user message (forces a 2-LLM-call pattern like Twenty's)
 *
 * 6 accounts × 3 runs × 3 workloads × 2 shapes = 108 runs.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readProjection, type Projection } from './readers/agent_crm.js';
import { callDeepSeek, V1_MODEL, type ChatMessage, type Tool } from './lib/llm.js';
import { saveReceipt } from './lib/receipts.js';
import { WORKLOADS, type WorkloadName, type Workload } from './lib/workloads.js';
import { summarize, type RunRow as SummaryRunRow } from './lib/summary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(__dirname, 'results');
const RUNS_PATH = resolve(RESULTS_DIR, 'runs.jsonl');

const ACCOUNTS = ['11x.ai', 'Sendbird', 'Trigify.io', 'Ramp', 'Netic', 'Explorium'];
const RUNS_PER_ACCOUNT = 3;
const WORKLOAD_NAMES: WorkloadName[] = ['draft', 'brief', 'score'];
type ExpShape = 'tree' | 'tool-call';

interface RunRow {
  workload: WorkloadName;
  platform: 'agent-crm';
  shape: ExpShape;
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

// Tree shape: nest collections under account.
function asTree(p: Projection): unknown {
  return {
    account: {
      id: p.account.id,
      name: p.account.name,
      attributes: p.account.attributes,
      facts: p.facts,
      contacts: p.contacts,
      signals: p.signals,
      past_touch: p.past_touch,
    },
  };
}

async function runTree(workload: Workload, account: string, run: number): Promise<RunRow> {
  try {
    const tStart = Date.now();
    const r = await readProjection(account);
    const tree = asTree(r.projection);
    saveReceipt({ platform: 'agent-crm', account, run, stage: `${workload.name}_tree_projection` }, { tree, api_calls: r.api_calls });

    const messages: ChatMessage[] = [
      { role: 'system', content: workload.systemPromptAgentCrm },
      { role: 'user', content: `Account: ${account}\n\nProjection:\n${JSON.stringify(tree)}\n\nProduce the output.` },
    ];
    const llm = await callDeepSeek(messages);
    saveReceipt({ platform: 'agent-crm', account, run, stage: `${workload.name}_tree_llm`, model: V1_MODEL }, {
      request_messages: messages, response: llm.response_body, content: llm.content,
      input_tokens: llm.input_tokens, output_tokens: llm.output_tokens, latency_ms: llm.latency_ms,
    });
    return {
      workload: workload.name, platform: 'agent-crm', shape: 'tree', account, run,
      input_tokens: llm.input_tokens, output_tokens: llm.output_tokens, total_tokens: llm.input_tokens + llm.output_tokens,
      llm_calls: 1, api_calls_to_data_store: r.api_calls, total_latency_ms: Date.now() - tStart,
      draft: llm.content, ok: !!llm.content,
      error: llm.content ? undefined : `no content (finish_reason: ${llm.finish_reason})`,
    };
  } catch (e) {
    return {
      workload: workload.name, platform: 'agent-crm', shape: 'tree', account, run,
      input_tokens: 0, output_tokens: 0, total_tokens: 0, llm_calls: 0, api_calls_to_data_store: 0, total_latency_ms: 0,
      draft: null, ok: false, error: (e as Error).message,
    };
  }
}

const READ_TOOL: Tool = {
  type: 'function',
  function: {
    name: 'read_account_projection',
    description: 'Fetch the agent-crm projection for an account by name. Returns account + facts + contacts + signals + past_touch in one bundled response.',
    parameters: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] },
  },
};

async function runToolCall(workload: Workload, account: string, run: number): Promise<RunRow> {
  try {
    const tStart = Date.now();
    const messages: ChatMessage[] = [
      { role: 'system', content: `${workload.systemPromptAgentCrm}\n\nUse the read_account_projection tool first to fetch the data, then produce the output.` },
      { role: 'user', content: `Account: ${account}\n\nProduce the output.` },
    ];
    let totalInput = 0, totalOutput = 0, llmCalls = 0, dataCalls = 0;
    const MAX_TURNS = 6;
    let finalContent: string | null = null;
    let r: { projection: Projection; api_calls: number } | null = null;

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      const llm = await callDeepSeek(messages, [READ_TOOL]);
      llmCalls++;
      totalInput += llm.input_tokens;
      totalOutput += llm.output_tokens;
      saveReceipt({ platform: 'agent-crm', account, run, stage: `${workload.name}_toolcall_turn${turn}_llm`, model: V1_MODEL }, {
        request_messages: messages, response: llm.response_body, content: llm.content, tool_calls: llm.tool_calls,
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
        if (tc.name === 'read_account_projection') {
          if (!r) { r = await readProjection(account); dataCalls += r.api_calls; }
          saveReceipt({ platform: 'agent-crm', account, run, stage: `${workload.name}_toolcall_turn${turn}_tool_read` }, { projection: r.projection });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(r.projection) });
        }
      }
    }
    return {
      workload: workload.name, platform: 'agent-crm', shape: 'tool-call', account, run,
      input_tokens: totalInput, output_tokens: totalOutput, total_tokens: totalInput + totalOutput,
      llm_calls: llmCalls, api_calls_to_data_store: dataCalls, total_latency_ms: Date.now() - tStart,
      draft: finalContent, ok: !!finalContent,
      error: finalContent ? undefined : 'no final content (max turns)',
    };
  } catch (e) {
    return {
      workload: workload.name, platform: 'agent-crm', shape: 'tool-call', account, run,
      input_tokens: 0, output_tokens: 0, total_tokens: 0, llm_calls: 0, api_calls_to_data_store: 0, total_latency_ms: 0,
      draft: null, ok: false, error: (e as Error).message,
    };
  }
}

async function main() {
  console.log('agent-crm experiments: tree + tool-call');
  console.log(`accounts: ${ACCOUNTS.length}, runs per workload per shape: ${RUNS_PER_ACCOUNT}\n`);
  mkdirSync(RESULTS_DIR, { recursive: true });

  const newRows: RunRow[] = [];
  for (const workloadName of WORKLOAD_NAMES) {
    const workload = WORKLOADS[workloadName];
    console.log(`\n========== workload: ${workloadName} ==========`);
    for (const account of ACCOUNTS) {
      for (let run = 1; run <= RUNS_PER_ACCOUNT; run++) {
        const tr = await runTree(workload, account, run);
        newRows.push(tr);
        appendFileSync(RUNS_PATH, JSON.stringify(tr) + '\n');
        console.log(`  ${workloadName}/ac/tree     ${account.padEnd(14)} run ${run}: ${tr.ok ? `${tr.input_tokens}in / ${tr.output_tokens}out / 1 LLM / ${tr.total_latency_ms}ms` : `FAILED: ${tr.error}`}`);
        const tc = await runToolCall(workload, account, run);
        newRows.push(tc);
        appendFileSync(RUNS_PATH, JSON.stringify(tc) + '\n');
        console.log(`  ${workloadName}/ac/toolcall ${account.padEnd(14)} run ${run}: ${tc.ok ? `${tc.input_tokens}in / ${tc.output_tokens}out / ${tc.llm_calls} LLM / ${tc.total_latency_ms}ms` : `FAILED: ${tc.error}`}`);
      }
    }
  }

  const allRows = readFileSync(RUNS_PATH, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const summary = summarize(allRows as SummaryRunRow[], ACCOUNTS, RUNS_PER_ACCOUNT);
  writeFileSync(resolve(RESULTS_DIR, 'summary.md'), summary);
  console.log(`\n--- ${newRows.length} new agent-crm experiment rows (${newRows.filter((r) => r.ok).length} ok, ${newRows.filter((r) => !r.ok).length} failed) ---`);
}

main().catch((e) => { console.error(e); process.exit(1); });
