/**
 * agent-crm experiment: production text format.
 *
 * Production's drafter (inngest/functions/agent_logic.ts: buildUserPrompt)
 * delivers context as plain text with section headers, NOT as a JSON
 * projection. This shape mirrors that format exactly so we can measure what
 * agent-crm's TRUE production cost looks like.
 *
 * Format:
 *   ACCOUNT: <name>
 *   ATTRIBUTES: {...json blob of account attributes...}
 *
 *   ACTIVE FACTS (already asserted — do not duplicate):
 *     fact_id | predicate=object (conf=...)
 *     ...
 *
 *   CONTACTS (linked to this account):
 *     Name <email> — role
 *     ...
 *
 *   PAST TOUCH (most recent outbound — ~Nd ago):
 *     <body>
 *
 *   RECENT SIGNALS:
 *     signal_id | type @ Nd ago: body
 *     ...
 *
 *   <workload-specific instruction>
 *
 * Saves rows with shape='prod-text' so we can compare to projection / tree.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readProjection, type Projection } from './readers/agent_crm.js';
import { callDeepSeek, V1_MODEL, type ChatMessage } from './lib/llm.js';
import { saveReceipt } from './lib/receipts.js';
import { WORKLOADS, type WorkloadName, type Workload } from './lib/workloads.js';
import { summarize, type RunRow as SummaryRunRow } from './lib/summary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(__dirname, 'results');
const RUNS_PATH = resolve(RESULTS_DIR, 'runs.jsonl');

const ACCOUNTS = ['11x.ai', 'Sendbird', 'Trigify.io', 'Ramp', 'Netic', 'Explorium'];
const RUNS_PER_ACCOUNT = 3;
const WORKLOAD_NAMES: WorkloadName[] = ['draft', 'brief', 'score'];

interface RunRow {
  workload: WorkloadName;
  platform: 'agent-crm';
  shape: 'prod-text';
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

/** Render the agent-crm projection as production-style plain text. */
function asProductionText(p: Projection): string {
  const accountAttrs = JSON.stringify(p.account.attributes, null, 2);

  const factsBlock = p.facts.length
    ? p.facts.map((f) => `  ${f.id} | ${f.predicate}=${f.object ?? '(none)'} (conf=${f.confidence})`).join('\n')
    : '  (none)';

  const contactsBlock = p.contacts.length
    ? p.contacts.map((c) => `  ${c.name} <${c.email}>${c.role ? ` — ${c.role}` : ''} [${c.id}]`).join('\n')
    : '  (none)';

  const pastTouchBlock = p.past_touch
    ? `[${p.past_touch.id}] sent ~${p.past_touch.days_ago}d ago:\n${p.past_touch.body}`
    : '(none)';

  const signalsBlock = p.signals.length
    ? p.signals.map((s) => {
        const days = Math.max(0, Math.round((Date.now() - new Date(s.observed_at).getTime()) / 86400_000));
        return `  ${s.id} | ${s.type} @ ${days}d ago: ${s.body.slice(0, 200)}`;
      }).join('\n')
    : '  (none)';

  return `ACCOUNT: ${p.account.name}
ATTRIBUTES (already known — do not re-extract these as facts):
${accountAttrs}

ACTIVE FACTS (already asserted — do not duplicate):
${factsBlock}

CONTACTS (linked to this account — pick the best fit for the role you're targeting):
${contactsBlock}

PAST TOUCH:
${pastTouchBlock}

RECENT SIGNALS:
${signalsBlock}`;
}

async function runProdText(workload: Workload, account: string, run: number): Promise<RunRow> {
  try {
    const tStart = Date.now();
    const r = await readProjection(account);
    const prodText = asProductionText(r.projection);
    saveReceipt({ platform: 'agent-crm', account, run, stage: `${workload.name}_prod_text_context` }, { text: prodText, api_calls: r.api_calls });

    const messages: ChatMessage[] = [
      { role: 'system', content: workload.systemPromptAgentCrm },
      { role: 'user', content: `${prodText}\n\nProduce the output.` },
    ];
    const llm = await callDeepSeek(messages);
    saveReceipt({ platform: 'agent-crm', account, run, stage: `${workload.name}_prod_text_llm`, model: V1_MODEL }, {
      request_messages: messages, response: llm.response_body, content: llm.content,
      input_tokens: llm.input_tokens, output_tokens: llm.output_tokens, latency_ms: llm.latency_ms,
    });
    return {
      workload: workload.name, platform: 'agent-crm', shape: 'prod-text', account, run,
      input_tokens: llm.input_tokens, output_tokens: llm.output_tokens, total_tokens: llm.input_tokens + llm.output_tokens,
      llm_calls: 1, api_calls_to_data_store: r.api_calls, total_latency_ms: Date.now() - tStart,
      draft: llm.content, ok: !!llm.content,
      error: llm.content ? undefined : `no content (finish_reason: ${llm.finish_reason})`,
    };
  } catch (e) {
    return {
      workload: workload.name, platform: 'agent-crm', shape: 'prod-text', account, run,
      input_tokens: 0, output_tokens: 0, total_tokens: 0, llm_calls: 0, api_calls_to_data_store: 0, total_latency_ms: 0,
      draft: null, ok: false, error: (e as Error).message,
    };
  }
}

async function main() {
  console.log('agent-crm production-format experiment (text, not JSON)');
  mkdirSync(RESULTS_DIR, { recursive: true });
  const newRows: RunRow[] = [];
  for (const workloadName of WORKLOAD_NAMES) {
    const workload = WORKLOADS[workloadName];
    console.log(`\n========== workload: ${workloadName} ==========`);
    for (const account of ACCOUNTS) {
      for (let run = 1; run <= RUNS_PER_ACCOUNT; run++) {
        const r = await runProdText(workload, account, run);
        newRows.push(r);
        appendFileSync(RUNS_PATH, JSON.stringify(r) + '\n');
        console.log(`  ${workloadName}/ac/prod-text ${account.padEnd(14)} run ${run}: ${r.ok ? `${r.input_tokens}in / ${r.output_tokens}out / ${r.total_latency_ms}ms` : `FAILED: ${r.error}`}`);
      }
    }
  }
  const allRows = readFileSync(RUNS_PATH, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const summary = summarize(allRows as SummaryRunRow[], ACCOUNTS, RUNS_PER_ACCOUNT);
  writeFileSync(resolve(RESULTS_DIR, 'summary.md'), summary);
  console.log(`\n--- ${newRows.length} prod-text rows (${newRows.filter((r) => r.ok).length} ok, ${newRows.filter((r) => !r.ok).length} failed) ---`);
}

main().catch((e) => { console.error(e); process.exit(1); });
