/**
 * Retry just the failed runs from v1 benchmark, append fresh results to
 * runs.jsonl (keyed by workload+platform+shape+account+run), regenerate summary.
 *
 * Use when a transient network failure (terminated / fetch failed / etc.) left
 * holes in the dataset. Successful runs are preserved unchanged.
 *
 *   pnpm exec tsx benchmark/v1/retry_failures.ts
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readProjection } from './readers/agent_crm.js';
import { HUBSPOT_TOOLS, execTool, type HubSpotShape } from './readers/hubspot.js';
import { DAYAI_TOOLS, execDayAiTool, clearProjectionCache, type DayAiShape } from './readers/dayai.js';
import { callDeepSeek, V1_MODEL, type ChatMessage } from './lib/llm.js';
import { saveReceipt } from './lib/receipts.js';
import { WORKLOADS, type WorkloadName, type Workload } from './lib/workloads.js';
import { summarize, type RunRow as SummaryRunRow } from './lib/summary.js';

const ACCOUNTS = ['11x.ai', 'Sendbird', 'Trigify.io', 'Ramp', 'Netic', 'Explorium'];
const RUNS_PER_ACCOUNT = 3;

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(__dirname, 'results');
const RUNS_PATH = resolve(RESULTS_DIR, 'runs.jsonl');

interface RunRow {
  workload: WorkloadName;
  platform: 'agent-crm' | 'hubspot' | 'dayai';
  shape: 'projection' | HubSpotShape | DayAiShape;
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

const keyOf = (r: RunRow) => `${r.workload}|${r.platform}|${r.shape}|${r.account}|${r.run}`;

async function runAgentCrm(workload: Workload, account: string, run: number): Promise<RunRow> {
  try {
    const tStart = Date.now();
    const r = await readProjection(account);
    saveReceipt({ platform: 'agent-crm', account, run, stage: `${workload.name}_projection` }, {
      workload: workload.name,
      projection: r.projection,
      raw_supabase_responses: r.raw_supabase_responses,
      api_calls: r.api_calls,
      latency_ms: r.latency_ms,
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: workload.systemPromptAgentCrm },
      { role: 'user', content: `Account: ${account}\n\nProjection:\n${JSON.stringify(r.projection)}\n\nProduce the output.` },
    ];
    const llm = await callDeepSeek(messages);
    saveReceipt({ platform: 'agent-crm', account, run, stage: `${workload.name}_llm`, model: V1_MODEL }, {
      workload: workload.name, request_messages: messages, response: llm.response_body,
      content: llm.content, input_tokens: llm.input_tokens, output_tokens: llm.output_tokens, latency_ms: llm.latency_ms,
    });
    return {
      workload: workload.name, platform: 'agent-crm', shape: 'projection', account, run,
      input_tokens: llm.input_tokens, output_tokens: llm.output_tokens, total_tokens: llm.input_tokens + llm.output_tokens,
      llm_calls: 1, api_calls_to_data_store: r.api_calls, total_latency_ms: Date.now() - tStart,
      draft: llm.content, ok: !!llm.content,
      error: llm.content ? undefined : `no content (finish_reason: ${llm.finish_reason})`,
    };
  } catch (e) {
    return {
      workload: workload.name, platform: 'agent-crm', shape: 'projection', account, run,
      input_tokens: 0, output_tokens: 0, total_tokens: 0,
      llm_calls: 0, api_calls_to_data_store: 0, total_latency_ms: 0,
      draft: null, ok: false, error: (e as Error).message,
    };
  }
}

async function runDayAi(workload: Workload, account: string, run: number, shape: DayAiShape): Promise<RunRow> {
  try {
    const tStart = Date.now();
    clearProjectionCache();
    const messages: ChatMessage[] = [
      { role: 'system', content: workload.systemPromptDayAi },
      { role: 'user', content: workload.userPromptDayAi(account) },
    ];
    let totalInput = 0, totalOutput = 0, llmCalls = 0, dataCalls = 0;
    const MAX_TURNS = 12;
    let finalContent: string | null = null;
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      const llm = await callDeepSeek(messages, DAYAI_TOOLS);
      llmCalls++; totalInput += llm.input_tokens; totalOutput += llm.output_tokens;
      saveReceipt({ platform: 'agent-crm', account, run, stage: `dayai_${workload.name}_${shape}_turn${turn}_llm_retry`, model: V1_MODEL }, {
        workload: workload.name, shape, platform: 'dayai',
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
        const apiCall = await execDayAiTool(tc.name, args, account, shape);
        dataCalls++;
        saveReceipt({ platform: 'agent-crm', account, run, stage: `dayai_${workload.name}_${shape}_turn${turn}_tool_${tc.name}_retry` }, { workload: workload.name, shape, platform: 'dayai', ...apiCall });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(apiCall.response.body) });
      }
    }
    return {
      workload: workload.name, platform: 'dayai', shape, account, run,
      input_tokens: totalInput, output_tokens: totalOutput, total_tokens: totalInput + totalOutput,
      llm_calls: llmCalls, api_calls_to_data_store: dataCalls, total_latency_ms: Date.now() - tStart,
      draft: finalContent, ok: !!finalContent,
      error: finalContent ? undefined : 'no final content (max turns)',
    };
  } catch (e) {
    return {
      workload: workload.name, platform: 'dayai', shape, account, run,
      input_tokens: 0, output_tokens: 0, total_tokens: 0,
      llm_calls: 0, api_calls_to_data_store: 0, total_latency_ms: 0,
      draft: null, ok: false, error: (e as Error).message,
    };
  }
}

async function runHubSpot(workload: Workload, account: string, run: number, shape: HubSpotShape): Promise<RunRow> {
  try {
    const tStart = Date.now();
    const messages: ChatMessage[] = [
      { role: 'system', content: workload.systemPromptHubSpot },
      { role: 'user', content: workload.userPromptHubSpot(account) },
    ];
    let totalInput = 0, totalOutput = 0, llmCalls = 0, dataCalls = 0;
    const MAX_TURNS = 12;
    let finalContent: string | null = null;
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      const llm = await callDeepSeek(messages, HUBSPOT_TOOLS);
      llmCalls++; totalInput += llm.input_tokens; totalOutput += llm.output_tokens;
      saveReceipt({ platform: 'hubspot', account, run, stage: `${workload.name}_${shape}_turn${turn}_llm`, model: V1_MODEL }, {
        workload: workload.name, shape, request_messages: messages, response: llm.response_body,
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
        const apiCall = await execTool(tc.name, args, shape);
        dataCalls++;
        saveReceipt({ platform: 'hubspot', account, run, stage: `${workload.name}_${shape}_turn${turn}_tool_${tc.name}` }, { workload: workload.name, shape, ...apiCall });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(apiCall.response.body) });
      }
    }
    return {
      workload: workload.name, platform: 'hubspot', shape, account, run,
      input_tokens: totalInput, output_tokens: totalOutput, total_tokens: totalInput + totalOutput,
      llm_calls: llmCalls, api_calls_to_data_store: dataCalls, total_latency_ms: Date.now() - tStart,
      draft: finalContent, ok: !!finalContent,
      error: finalContent ? undefined : 'no final content (max turns)',
    };
  } catch (e) {
    return {
      workload: workload.name, platform: 'hubspot', shape, account, run,
      input_tokens: 0, output_tokens: 0, total_tokens: 0,
      llm_calls: 0, api_calls_to_data_store: 0, total_latency_ms: 0,
      draft: null, ok: false, error: (e as Error).message,
    };
  }
}

async function main() {
  // 1. Read all existing rows
  const allRows: RunRow[] = readFileSync(RUNS_PATH, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const okRows = allRows.filter((r) => r.ok);
  const failedRows = allRows.filter((r) => !r.ok);

  console.log(`current state: ${allRows.length} total, ${okRows.length} ok, ${failedRows.length} failed`);
  if (failedRows.length === 0) { console.log('no failures to retry'); return; }

  // 2. Retry each failed run
  const retried: RunRow[] = [];
  for (const f of failedRows) {
    const workload = WORKLOADS[f.workload];
    console.log(`retrying: ${f.workload}/${f.platform}${f.shape !== 'projection' ? `/${f.shape}` : ''} ${f.account} run ${f.run} (prior error: ${f.error})`);
    let r: RunRow;
    if (f.platform === 'agent-crm') {
      r = await runAgentCrm(workload, f.account, f.run);
    } else if (f.platform === 'hubspot') {
      r = await runHubSpot(workload, f.account, f.run, f.shape as HubSpotShape);
    } else if (f.platform === 'dayai') {
      r = await runDayAi(workload, f.account, f.run, f.shape as DayAiShape);
    } else {
      throw new Error(`unknown platform: ${f.platform}`);
    }
    retried.push(r);
    console.log(`  → ${r.ok ? `ok: ${r.input_tokens}in / ${r.output_tokens}out / ${r.llm_calls} LLM / ${r.total_latency_ms}ms` : `FAILED again: ${r.error}`}`);
  }

  // 3. Rebuild runs.jsonl: keep all ok originals, replace each failure with its retry result
  const finalRows = [...okRows, ...retried];
  // Stable sort by workload, account, run, platform, shape for readability
  finalRows.sort((a, b) => {
    if (a.workload !== b.workload) return a.workload.localeCompare(b.workload);
    if (a.account !== b.account) return a.account.localeCompare(b.account);
    if (a.run !== b.run) return a.run - b.run;
    if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
    return String(a.shape).localeCompare(String(b.shape));
  });
  writeFileSync(RUNS_PATH, finalRows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const stillFailed = retried.filter((r) => !r.ok);
  console.log(`\ndone. ${retried.length} retries: ${retried.length - stillFailed.length} ok, ${stillFailed.length} still failed.`);
  if (stillFailed.length) {
    console.log('Still-failed runs (likely real, not transient):');
    for (const r of stillFailed) console.log(`  ${r.workload}/${r.platform}${r.shape !== 'projection' ? `/${r.shape}` : ''} ${r.account} run ${r.run}: ${r.error}`);
  }
  console.log(`\nFinal totals: ${finalRows.length} total, ${finalRows.filter((r) => r.ok).length} ok, ${finalRows.filter((r) => !r.ok).length} failed`);

  // 4. Regenerate summary
  const summaryPath = resolve(RESULTS_DIR, 'summary.md');
  const summary = summarize(finalRows as SummaryRunRow[], ACCOUNTS, RUNS_PER_ACCOUNT);
  writeFileSync(summaryPath, summary);
  console.log(`wrote ${summaryPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
