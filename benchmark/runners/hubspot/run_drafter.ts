/**
 * Realistic drafter benchmark: HubSpot side.
 *
 * Task: "Draft a personalized follow-up email to the right contact at this
 * account, referencing one specific fact about them and one prior touch."
 *
 * Method (mirrors what a HubSpot+agent customer actually has to do):
 *   Turn 1: model receives system + user → calls hubspot_get_company_by_name
 *   Turn 2: model receives company → calls hubspot_get_associated_contacts
 *   Turn 3: model receives contacts → calls hubspot_get_recent_notes
 *   Turn 4: model receives notes → emits the draft JSON
 *
 * This is structural to HubSpot's data model: companies, contacts, and
 * engagements live in separate tables traversed via associations. A drafter
 * MUST call all three to write a personalized email referencing facts about
 * the company, the right contact, and the prior touch.
 *
 * The company call hits real HubSpot (default-setup property set, envelope
 * preserved). The contacts and notes calls are STUBBED with documented
 * HubSpot v3 API response shapes — our service key lacks both scopes, but a
 * real customer would have them. Content matches the agent-crm seed.
 *
 * Usage:
 *   pnpm exec tsx benchmark/runners/hubspot/run_drafter.ts
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local' });
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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

const STUB_DATA: Record<string, { contacts: Array<{ first_name: string; last_name: string; email: string; role: string }>; past_touch: { subject: string; body: string; days_ago: number } }> = JSON.parse(
  readFileSync(resolve(__dirname, 'stub_data.json'), 'utf8'),
);

const SYSTEM_PROMPT = `You are an outbound drafter agent.
For the named account, draft a personalized follow-up email to the BEST contact.

Use the tools in this order:
  1. hubspot_get_company_by_name — fetch the company record
  2. hubspot_get_associated_contacts — fetch contacts at that company
  3. hubspot_get_recent_notes — fetch recent notes (past touches) for context

Then output strictly valid JSON, no preamble:
{"to": "<email>", "subject": "<subject>", "body": "<body>", "cites": ["<source_string>", ...]}

Rules:
- Pick the highest-seniority contact (CEO > CTO > COO > other).
- Subject < 60 chars.
- Body must reference ONE specific fact about the company AND the prior touch (note what we said last time).
- Body 2-4 sentences. Casual, founder-to-founder tone. No "I hope this finds you well."`;

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'hubspot_get_company_by_name',
      description: 'Fetch a HubSpot company by exact name.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'hubspot_get_associated_contacts',
      description: 'Fetch contacts associated with a HubSpot company id.',
      parameters: { type: 'object', properties: { company_id: { type: 'string' } }, required: ['company_id'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'hubspot_get_recent_notes',
      description: 'Fetch the 5 most recent notes (engagements) on a HubSpot company id.',
      parameters: { type: 'object', properties: { company_id: { type: 'string' } }, required: ['company_id'] },
    },
  },
];

const DEFAULT_COMPANY_PROPS = [
  'name', 'domain', 'industry', 'description', 'lifecyclestage', 'numberofemployees',
  'founded_year', 'type', 'hubspot_owner_id', 'createdate', 'hs_lastmodifieddate',
  'stack', 'agent_facts', 'agent_signals',
];

async function hubspotGetCompany(name: string): Promise<any> {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HS_TOKEN}` },
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: name }] }],
      properties: DEFAULT_COMPANY_PROPS,
      limit: 1,
    }),
  });
  if (!res.ok) throw new Error(`HubSpot search failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as { results: any[] };
  return json.results[0] ?? null;
}

// Documented HubSpot Contacts v3 batch response shape.
function stubContacts(accountName: string): any {
  const seed = STUB_DATA[accountName];
  if (!seed) return { results: [] };
  const nowIso = new Date().toISOString();
  return {
    results: seed.contacts.map((c, i) => ({
      id: `${Date.now()}${i}`.slice(-8),
      properties: {
        email: c.email,
        firstname: c.first_name,
        lastname: c.last_name,
        jobtitle: c.role,
        hs_object_id: `${Date.now()}${i}`.slice(-8),
        createdate: '2026-04-15T10:00:00.000Z',
        lastmodifieddate: nowIso,
      },
      createdAt: '2026-04-15T10:00:00.000Z',
      updatedAt: nowIso,
      archived: false,
    })),
  };
}

// Documented HubSpot Notes v3 search response shape.
function stubNotes(accountName: string): any {
  const seed = STUB_DATA[accountName];
  if (!seed) return { results: [], paging: null };
  const tsIso = new Date(Date.now() - seed.past_touch.days_ago * 86400_000).toISOString();
  return {
    results: [
      {
        id: '90210123',
        properties: {
          hs_note_body: `Subject: ${seed.past_touch.subject}\n\n${seed.past_touch.body}`,
          hs_timestamp: tsIso,
          hs_object_id: '90210123',
          hubspot_owner_id: '12345',
        },
        createdAt: tsIso,
        updatedAt: tsIso,
        archived: false,
      },
    ],
    paging: null,
  };
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
    body: JSON.stringify({ model: MODEL, max_tokens: 500, messages, tools: TOOLS, tool_choice: 'auto' }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{
    choices: Array<{ message: ChatMessage; finish_reason: string }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  }>;
}

async function draft(accountName: string) {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Account: ${accountName}\n\nDraft.` },
  ];

  const t0 = Date.now();
  let totalInput = 0, totalOutput = 0, llmCalls = 0, dataCalls = 0, turn = 0;
  const MAX_TURNS = 6;
  let lastContent: string | null = null;

  while (turn < MAX_TURNS) {
    turn++;
    llmCalls++;
    const r = await callOpenAI(messages);
    totalInput += r.usage.prompt_tokens;
    totalOutput += r.usage.completion_tokens;
    const choice = r.choices[0]!;
    messages.push({ role: 'assistant', content: choice.message.content, tool_calls: choice.message.tool_calls });

    if (!choice.message.tool_calls?.length) {
      lastContent = choice.message.content;
      break;
    }

    for (const tc of choice.message.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      let result: any;
      if (tc.function.name === 'hubspot_get_company_by_name') {
        result = await hubspotGetCompany(args.name);
        dataCalls++;
      } else if (tc.function.name === 'hubspot_get_associated_contacts') {
        result = stubContacts(accountName);
        dataCalls++;
      } else if (tc.function.name === 'hubspot_get_recent_notes') {
        result = stubNotes(accountName);
        dataCalls++;
      } else {
        result = { error: `unknown tool ${tc.function.name}` };
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }

  return {
    input_tokens: totalInput,
    output_tokens: totalOutput,
    latency_ms: Date.now() - t0,
    llm_calls: llmCalls,
    api_calls_to_data_store: dataCalls,
    decision_text: lastContent ?? '(max turns exceeded)',
  };
}

interface RunResult {
  system: 'hubspot';
  account: string;
  run: number;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  llm_calls: number;
  api_calls_to_data_store: number;
  decision_text: string;
}

async function main() {
  console.log(`HubSpot drafter runner (real company + stubbed contacts/notes)`);
  console.log(`model: ${MODEL}`);
  console.log(`accounts: ${ACCOUNTS.length}, runs per account: ${RUNS_PER_ACCOUNT}\n`);

  const results: RunResult[] = [];
  for (const name of ACCOUNTS) {
    for (let run = 1; run <= RUNS_PER_ACCOUNT; run++) {
      const r = await draft(name);
      results.push({ system: 'hubspot', account: name, run, ...r });
      console.log(`  ${name.padEnd(18)} run ${run}: ${r.input_tokens.toString().padStart(5)} in / ${r.output_tokens.toString().padStart(4)} out / ${r.latency_ms.toString().padStart(5)}ms / ${r.llm_calls} LLM / ${r.api_calls_to_data_store} data`);
    }
  }

  const tot_in = results.reduce((a, b) => a + b.input_tokens, 0);
  const tot_out = results.reduce((a, b) => a + b.output_tokens, 0);
  const avg_in = tot_in / results.length;
  const avg_lat = results.reduce((a, b) => a + b.latency_ms, 0) / results.length;
  const avg_calls = results.reduce((a, b) => a + b.llm_calls, 0) / results.length;
  const avg_data = results.reduce((a, b) => a + b.api_calls_to_data_store, 0) / results.length;

  console.log(`\nhubspot drafter summary (${results.length} runs)`);
  console.log(`  avg input tokens:  ${avg_in.toFixed(1)}`);
  console.log(`  avg output tokens: ${(tot_out / results.length).toFixed(1)}`);
  console.log(`  avg latency:       ${avg_lat.toFixed(0)} ms`);
  console.log(`  avg LLM calls:     ${avg_calls.toFixed(2)}`);
  console.log(`  avg data calls:    ${avg_data.toFixed(2)}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const out = resolve(OUT_DIR, 'drafter_hubspot.json');
  writeFileSync(out, JSON.stringify({
    system: 'hubspot',
    model: MODEL,
    runs: results,
    summary: {
      avg_input_tokens: avg_in,
      avg_output_tokens: tot_out / results.length,
      avg_latency_ms: avg_lat,
      avg_llm_calls: avg_calls,
      avg_data_calls: avg_data,
    },
  }, null, 2));
  console.log(`\nwrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
