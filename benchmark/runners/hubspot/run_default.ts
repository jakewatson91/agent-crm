/**
 * Token-cost benchmark runner: HubSpot "default setup" baseline.
 *
 * Difference from run.ts (the floor case):
 *   - The agent asks for the realistic default property set the HubSpot UI shows
 *     for a company (~12 standard fields + the 3 customs the founder created
 *     for the agent: stack, agent_facts, agent_signals).
 *   - The agent does NOT strip the HubSpot envelope. The full response is passed
 *     to the LLM as-is: { id, properties: {...}, createdAt, updatedAt, archived }.
 *   - Everything else (model, accounts, runs, system prompt, tool surface) is
 *     identical to run.ts so the only delta is the realism of the setup.
 *
 * This is what a founder gets on day 1: they turn on HubSpot, hook up an agent,
 * and the agent uses the company record without anyone hand-tuning the tool
 * wrapper to strip metadata or hand-picking 6 perfect fields.
 *
 * Usage:
 *   pnpm exec tsx benchmark/runners/hubspot/run_default.ts
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local' });
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../../metrics');

const HS_TOKEN = process.env.HUBSPOT_SERVICE_KEY!;
const OPENAI_KEY = process.env.OPENAI_API_KEY!;
if (!HS_TOKEN) throw new Error('Missing HUBSPOT_SERVICE_KEY');
if (!OPENAI_KEY) throw new Error('Missing OPENAI_API_KEY');

const MODEL = 'gpt-4o-mini';
const RUNS_PER_ACCOUNT = 3;
const ACCOUNTS = ['Resona Labs', 'Forge Robotics', 'Plaintext.so', 'Halo Health', 'Brightvine', 'Strand Compute'];

const SYSTEM_PROMPT = `You are an outbound-touch decision agent.
Given an account name, decide whether to send an outbound touch this week.
Use the hubspot_get_company_by_name tool to fetch context, then output strictly valid JSON:
{"decide": boolean, "reasoning": string, "citations": string[]}
- decide: true if a touch is warranted given the signals and ICP fit; false otherwise.
- reasoning: 1-2 sentences referencing specific account context.
- citations: array of fact_ids or signal_ids from the data you retrieved.`;

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'hubspot_get_company_by_name',
      description: 'Fetch a HubSpot company by exact name. Returns the full company record.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The exact company name' },
        },
        required: ['name'],
      },
    },
  },
];

// Realistic property set: the standard fields HubSpot's UI shows in the company
// sidebar + the custom fields the founder created for their agent. This is what
// a person setting up an agent would request — no hand-picking 6 perfect fields,
// no asking for 200 properties either.
const DEFAULT_PROPERTIES = [
  // Standard company fields HubSpot ships and displays prominently
  'name',
  'domain',
  'industry',
  'description',
  'lifecyclestage',
  'numberofemployees',
  'founded_year',
  'type',
  'hubspot_owner_id',
  'createdate',
  'hs_lastmodifieddate',
  // Custom fields the founder added for the agent (same ones mirror_seed creates)
  'stack',
  'agent_facts',
  'agent_signals',
];

async function hubspotSearchCompany(name: string): Promise<any> {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HS_TOKEN}` },
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: name }] }],
      properties: DEFAULT_PROPERTIES,
      limit: 1,
    }),
  });
  if (!res.ok) throw new Error(`HubSpot search failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as { results: any[] };
  // Pass the raw HubSpot response straight through to the LLM. No envelope
  // stripping. This is what an agent gets if no one writes a custom wrapper.
  return json.results[0] ?? null;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
}

async function callOpenAI(messages: ChatMessage[]) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{
    choices: Array<{ message: ChatMessage; finish_reason: string }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  }>;
}

async function decide(accountName: string) {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Account: ${accountName}\n\nDecide.` },
  ];

  const t0 = Date.now();
  let totalInput = 0;
  let totalOutput = 0;
  let apiCallsToHubspot = 0;
  let turn = 0;
  const MAX_TURNS = 4;

  while (turn < MAX_TURNS) {
    turn++;
    const r = await callOpenAI(messages);
    totalInput += r.usage.prompt_tokens;
    totalOutput += r.usage.completion_tokens;
    const choice = r.choices[0]!;

    messages.push({
      role: 'assistant',
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
    });

    if (!choice.message.tool_calls?.length) {
      const latency_ms = Date.now() - t0;
      return {
        input_tokens: totalInput,
        output_tokens: totalOutput,
        latency_ms,
        api_calls_to_data_store: apiCallsToHubspot,
        turns: turn,
        decision_text: choice.message.content ?? '',
      };
    }

    for (const tc of choice.message.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      let result: any;
      if (tc.function.name === 'hubspot_get_company_by_name') {
        apiCallsToHubspot++;
        result = await hubspotSearchCompany(args.name);
      } else {
        result = { error: `unknown tool ${tc.function.name}` };
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  const latency_ms = Date.now() - t0;
  return {
    input_tokens: totalInput,
    output_tokens: totalOutput,
    latency_ms,
    api_calls_to_data_store: apiCallsToHubspot,
    turns: turn,
    decision_text: '(max turns exceeded without final decision)',
  };
}

interface RunResult {
  system: 'hubspot-default';
  account: string;
  run: number;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  api_calls_to_data_store: number;
  turns: number;
  decision_text: string;
}

async function main() {
  console.log(`hubspot default-setup runner`);
  console.log(`model: ${MODEL}`);
  console.log(`accounts: ${ACCOUNTS.length}, runs per account: ${RUNS_PER_ACCOUNT}\n`);

  const results: RunResult[] = [];

  for (const accountName of ACCOUNTS) {
    for (let run = 1; run <= RUNS_PER_ACCOUNT; run++) {
      const r = await decide(accountName);
      results.push({
        system: 'hubspot-default',
        account: accountName,
        run,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        latency_ms: r.latency_ms,
        api_calls_to_data_store: r.api_calls_to_data_store,
        turns: r.turns,
        decision_text: r.decision_text,
      });
      console.log(`  ${accountName.padEnd(18)} run ${run}: ${r.input_tokens.toString().padStart(5)} in / ${r.output_tokens.toString().padStart(4)} out / ${r.latency_ms.toString().padStart(5)}ms / ${r.turns} turns / ${r.api_calls_to_data_store} hs-calls`);
    }
  }

  const tot_in = results.reduce((a, b) => a + b.input_tokens, 0);
  const tot_out = results.reduce((a, b) => a + b.output_tokens, 0);
  const avg_in = tot_in / results.length;
  const avg_lat = results.reduce((a, b) => a + b.latency_ms, 0) / results.length;
  const avg_turns = results.reduce((a, b) => a + b.turns, 0) / results.length;
  const avg_hs = results.reduce((a, b) => a + b.api_calls_to_data_store, 0) / results.length;

  console.log(`\nhubspot default-setup summary (${results.length} runs)`);
  console.log(`  avg input tokens:  ${avg_in.toFixed(1)}`);
  console.log(`  avg output tokens: ${(tot_out / results.length).toFixed(1)}`);
  console.log(`  avg latency:       ${avg_lat.toFixed(0)} ms`);
  console.log(`  avg turns:         ${avg_turns.toFixed(2)}`);
  console.log(`  avg hs api calls:  ${avg_hs.toFixed(2)}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const out = resolve(OUT_DIR, 'token_cost_hubspot_default.json');
  writeFileSync(out, JSON.stringify({
    system: 'hubspot-default',
    model: MODEL,
    runs: results,
    summary: {
      avg_input_tokens: avg_in,
      avg_output_tokens: tot_out / results.length,
      avg_latency_ms: avg_lat,
      avg_turns,
      avg_hubspot_api_calls: avg_hs,
    },
  }, null, 2));
  console.log(`\nwrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
