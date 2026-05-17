/**
 * Walkthrough of the realistic-drafter benchmark for ONE account.
 * Shows the exact data each side reads, every LLM turn, and the final draft.
 *
 * Usage: pnpm exec tsx scripts/demo_drafter_walkthrough.ts "Forge Robotics"
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreFacts } from '@agent-crm/tools';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HS_TOKEN = process.env.HUBSPOT_SERVICE_KEY!;
const OPENAI_KEY = process.env.OPENAI_API_KEY!;
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);
const MODEL = 'gpt-4o-mini';
const ACCOUNT = process.argv[2] || 'Forge Robotics';

const STUB_DATA: Record<string, any> = JSON.parse(
  readFileSync(resolve(__dirname, '../benchmark/runners/hubspot/stub_data.json'), 'utf8'),
);

const DRAFTER_SYSTEM = `You are an outbound drafter agent.
For the named account, draft a personalized follow-up email to the BEST contact.
Use the available tools to gather context, then output strictly valid JSON:
{"to": "<email>", "subject": "<subject>", "body": "<body>", "cites": ["<source_string>", ...]}
Rules:
- Pick the highest-seniority contact (CEO > CTO > COO > other).
- Subject < 60 chars.
- Body must reference ONE specific fact AND the prior touch.
- Body 2-4 sentences. Casual founder-to-founder tone. No "I hope this finds you well."
- If the projection includes a "recommended" shortlist, prefer one of those facts as your anchor unless the past_touch context demands otherwise.`;

// ────────────────────────────────────────────────────────────
// agent-crm side
// ────────────────────────────────────────────────────────────
async function buildAgentCrmProjection() {
  const ws = await supabase.from('workspaces').select('id').like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  const wsId = ws.data!.id as string;
  const ent = await supabase.from('entities').select('id, name, attributes').eq('workspace_id', wsId).eq('kind', 'account').eq('name', ACCOUNT).single();
  const accountId = ent.data!.id as string;

  const allFacts = await supabase.from('facts').select('id, predicate, object_text, confidence, supersedes').eq('workspace_id', wsId).eq('subject_entity', accountId);
  const supSet = new Set((allFacts.data ?? []).map((f) => f.supersedes as string | null).filter((x): x is string => !!x));
  const facts = (allFacts.data ?? []).filter((f) => !supSet.has(f.id as string)).map((f) => ({ id: f.id, predicate: f.predicate, object: f.object_text, confidence: f.confidence }));

  const worksAt = await supabase.from('facts').select('subject_entity').eq('workspace_id', wsId).eq('predicate', 'works_at').eq('object_entity', accountId);
  const contactIds = (worksAt.data ?? []).map((f) => f.subject_entity as string);
  const contactEnts = contactIds.length ? await supabase.from('entities').select('id, name, attributes').in('id', contactIds).eq('kind', 'contact') : { data: [] };
  const contacts = (contactEnts.data ?? []).map((e: any) => ({ id: e.id, name: e.name, email: e.attributes?.email, role: e.attributes?.role }));

  const ch = await supabase.from('channels').select('id').eq('workspace_id', wsId).eq('account_entity_id', accountId).maybeSingle();
  let past_touch: any = null;
  if (ch.data?.id) {
    const posts = await supabase.from('channel_posts').select('body, created_at').eq('channel_id', ch.data.id).eq('kind', 'touch_draft').order('created_at', { ascending: false }).limit(1);
    if (posts.data?.[0]) {
      const days = Math.round((Date.now() - new Date(posts.data[0].created_at as string).getTime()) / 86400_000);
      past_touch = { body: posts.data[0].body, days_ago: days };
    }
  }

  const sigs = await supabase.from('signals').select('id, type, magnitude, body_for_embedding, observed_at').eq('workspace_id', wsId).eq('entity_id', accountId).order('observed_at', { ascending: false }).limit(5);
  const signals = (sigs.data ?? []).map((s) => ({ id: s.id, type: s.type, magnitude: s.magnitude, body: s.body_for_embedding, observed_at: s.observed_at }));

  const shortlist = await scoreFacts(supabase, {
    workspace_id: wsId,
    account_entity_id: accountId,
    facts: facts.map((f: any) => ({ id: f.id, predicate: f.predicate, object_text: f.object, confidence: f.confidence, observed_at: new Date().toISOString(), source_event_id: null })),
  });
  const recommended = shortlist.map((r) => ({ id: r.id, score: Number(r.score.toFixed(2)), why: r.why }));
  return { account: { id: accountId, name: ent.data!.name, attributes: ent.data!.attributes }, facts, contacts, past_touch, signals, recommended };
}

async function callLLM(messages: any[], tools?: any[]) {
  const body: any = { model: MODEL, max_tokens: 500, messages };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  else body.response_format = { type: 'json_object' };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function runAgentCrm() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`AGENT-CRM SIDE — ${ACCOUNT}`);
  console.log('══════════════════════════════════════════════════════════════');
  const proj = await buildAgentCrmProjection();
  const projStr = JSON.stringify(proj);
  console.log(`\nProjection (one Supabase round-trip, 5 small reads bundled):`);
  console.log(`  facts:      ${proj.facts.length}`);
  console.log(`  contacts:   ${proj.contacts.length}`);
  console.log(`  past_touch: ${proj.past_touch ? 'yes (' + proj.past_touch.days_ago + 'd ago)' : 'no'}`);
  console.log(`  signals:    ${proj.signals.length}`);
  console.log(`  recommended shortlist (top ${proj.recommended.length}):`);
  for (const r of proj.recommended) {
    const f = proj.facts.find((x: any) => x.id === r.id);
    console.log(`    ${r.score.toFixed(2)}  ${f?.predicate}=${f?.object}  (${r.why})`);
  }
  console.log(`  projection chars: ${projStr.length}`);
  console.log(`\n  Full projection passed to LLM:`);
  console.log('  ' + projStr.replace(/\n/g, '\n  ').slice(0, 1400));

  const messages = [
    { role: 'system', content: DRAFTER_SYSTEM },
    { role: 'user', content: `Account: ${ACCOUNT}\n\nProjection:\n${projStr}\n\nDraft.` },
  ];
  console.log('\n── LLM TURN 1 (only turn) ──');
  const t0 = Date.now();
  const r = await callLLM(messages);
  const lat = Date.now() - t0;
  console.log(`  input_tokens:  ${r.usage.prompt_tokens}`);
  console.log(`  output_tokens: ${r.usage.completion_tokens}`);
  console.log(`  latency:       ${lat}ms`);
  console.log(`\n  Draft produced:`);
  console.log('  ' + r.choices[0].message.content.replace(/\n/g, '\n  '));
  return { input: r.usage.prompt_tokens, output: r.usage.completion_tokens, turns: 1, latency: lat };
}

// ────────────────────────────────────────────────────────────
// HubSpot side
// ────────────────────────────────────────────────────────────
const HS_TOOLS = [
  { type: 'function', function: { name: 'hubspot_get_company_by_name', description: 'Fetch HubSpot company by name', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'hubspot_get_associated_contacts', description: 'Fetch contacts at a HubSpot company', parameters: { type: 'object', properties: { company_id: { type: 'string' } }, required: ['company_id'] } } },
  { type: 'function', function: { name: 'hubspot_get_recent_notes', description: 'Fetch recent notes for a HubSpot company', parameters: { type: 'object', properties: { company_id: { type: 'string' } }, required: ['company_id'] } } },
];

async function hsGetCompany(name: string) {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HS_TOKEN}` },
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: name }] }],
      properties: ['name', 'domain', 'industry', 'description', 'lifecyclestage', 'numberofemployees', 'founded_year', 'type', 'hubspot_owner_id', 'createdate', 'hs_lastmodifieddate', 'stack', 'agent_facts', 'agent_signals'],
      limit: 1,
    }),
  });
  const j = await res.json();
  return j.results?.[0] ?? null;
}
function stubContacts(name: string) {
  const s = STUB_DATA[name];
  return { results: s.contacts.map((c: any, i: number) => ({ id: `${Date.now()}${i}`.slice(-8), properties: { email: c.email, firstname: c.first_name, lastname: c.last_name, jobtitle: c.role, hs_object_id: `${Date.now()}${i}`.slice(-8), createdate: '2026-04-15T10:00:00.000Z', lastmodifieddate: new Date().toISOString() }, createdAt: '2026-04-15T10:00:00.000Z', updatedAt: new Date().toISOString(), archived: false })) };
}
function stubNotes(name: string) {
  const s = STUB_DATA[name];
  const ts = new Date(Date.now() - s.past_touch.days_ago * 86400_000).toISOString();
  return { results: [{ id: '90210123', properties: { hs_note_body: `Subject: ${s.past_touch.subject}\n\n${s.past_touch.body}`, hs_timestamp: ts, hs_object_id: '90210123', hubspot_owner_id: '12345' }, createdAt: ts, updatedAt: ts, archived: false }], paging: null };
}

async function runHubspot() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`HUBSPOT SIDE — ${ACCOUNT}`);
  console.log('══════════════════════════════════════════════════════════════');
  const messages: any[] = [
    { role: 'system', content: DRAFTER_SYSTEM },
    { role: 'user', content: `Account: ${ACCOUNT}\n\nDraft.` },
  ];
  let turn = 0;
  const t0 = Date.now();
  let totalIn = 0, totalOut = 0;
  while (turn < 6) {
    turn++;
    console.log(`\n── LLM TURN ${turn} ──`);
    console.log(`  messages in context: ${messages.length}`);
    const r = await callLLM(messages, HS_TOOLS);
    totalIn += r.usage.prompt_tokens;
    totalOut += r.usage.completion_tokens;
    console.log(`  input_tokens this turn:  ${r.usage.prompt_tokens}  (cumulative: ${totalIn})`);
    console.log(`  output_tokens this turn: ${r.usage.completion_tokens}`);
    const choice = r.choices[0];
    messages.push({ role: 'assistant', content: choice.message.content, tool_calls: choice.message.tool_calls });
    if (!choice.message.tool_calls?.length) {
      console.log(`\n  Draft produced:`);
      console.log('  ' + (choice.message.content || '').replace(/\n/g, '\n  '));
      break;
    }
    for (const tc of choice.message.tool_calls) {
      console.log(`  → tool call: ${tc.function.name}`);
      const args = JSON.parse(tc.function.arguments);
      let result: any;
      if (tc.function.name === 'hubspot_get_company_by_name') result = await hsGetCompany(args.name);
      else if (tc.function.name === 'hubspot_get_associated_contacts') result = stubContacts(ACCOUNT);
      else if (tc.function.name === 'hubspot_get_recent_notes') result = stubNotes(ACCOUNT);
      const resultStr = JSON.stringify(result);
      console.log(`    result size: ${resultStr.length} chars`);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
    }
  }
  const lat = Date.now() - t0;
  console.log(`\nTotals: ${totalIn} input / ${totalOut} output / ${turn} LLM calls / ${lat}ms`);
  return { input: totalIn, output: totalOut, turns: turn, latency: lat };
}

async function main() {
  const ac = await runAgentCrm();
  const hs = await runHubspot();

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`SIDE-BY-SIDE — ${ACCOUNT}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`                  agent-crm    HubSpot   Ratio`);
  console.log(`  input tokens:   ${String(ac.input).padStart(7)}    ${String(hs.input).padStart(7)}   ${(hs.input / ac.input).toFixed(2)}×`);
  console.log(`  output tokens:  ${String(ac.output).padStart(7)}    ${String(hs.output).padStart(7)}   ${(hs.output / ac.output).toFixed(2)}×`);
  console.log(`  LLM turns:      ${String(ac.turns).padStart(7)}    ${String(hs.turns).padStart(7)}   ${(hs.turns / ac.turns).toFixed(2)}×`);
  console.log(`  latency (ms):   ${String(ac.latency).padStart(7)}    ${String(hs.latency).padStart(7)}   ${(hs.latency / ac.latency).toFixed(2)}×`);
}

main().catch((e) => { console.error(e); process.exit(1); });
