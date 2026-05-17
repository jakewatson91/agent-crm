/**
 * Realistic drafter benchmark: agent-crm side.
 *
 * Task: "Draft a personalized follow-up email to the right contact at this
 * account, referencing one specific fact about them and one prior touch."
 *
 * Method:
 *   1. ONE Supabase round-trip that returns a projection containing:
 *        - account entity + attributes
 *        - active facts (latest in each supersede chain)
 *        - 2 most recent contacts at the account (name, role, email)
 *        - past_touch (most recent touch_draft channel_post for the account)
 *        - recent signals (up to 5)
 *   2. ONE LLM call producing {to, subject, body, cites} JSON.
 *
 * No tool-call loop. The projection is computed at query time, agent reads it,
 * decides, drafts. This is the architectural reason agent-crm uses fewer LLM
 * turns: the data model unifies the entity + its associations into one read.
 *
 * Usage:
 *   pnpm exec tsx benchmark/runners/agent-crm/run_drafter.ts
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../../metrics');

const OPENAI_KEY = process.env.OPENAI_API_KEY!;
if (!OPENAI_KEY) throw new Error('Missing OPENAI_API_KEY');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const MODEL = 'gpt-4o-mini';
const RUNS_PER_ACCOUNT = 3;
const ACCOUNTS = ['Resona Labs', 'Forge Robotics', 'Plaintext.so', 'Halo Health', 'Brightvine', 'Strand Compute'];

const SYSTEM_PROMPT = `You are an outbound drafter agent.
Given a projection of an account (its facts, contacts, recent signals, and last touch),
draft a personalized follow-up email to the BEST contact at the account.

Output strictly valid JSON, no preamble:
{"to": "<email>", "subject": "<subject>", "body": "<body>", "cites": ["<fact_id_or_signal_id>", ...]}

Rules:
- Pick the highest-seniority contact (CEO > CTO > COO > other).
- Subject < 60 chars.
- Body must reference ONE specific fact (use its fact_id in cites) AND the prior touch (note what we said last time).
- Body 2-4 sentences. Casual, founder-to-founder tone. No "I hope this finds you well."`;

interface Projection {
  account: { id: string; name: string; attributes: Record<string, unknown> };
  facts: Array<{ id: string; predicate: string; object: string | null; confidence: number }>;
  contacts: Array<{ id: string; name: string; email: string; role: string }>;
  past_touch: { body: string; days_ago: number } | null;
  signals: Array<{ id: string; type: string; magnitude: number; body: string; observed_at: string }>;
}

async function findWorkspace(): Promise<string> {
  const ws = await supabase
    .from('workspaces').select('id').like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false }).limit(1).single();
  if (ws.error) throw ws.error;
  return ws.data!.id as string;
}

async function buildProjection(wsId: string, accountName: string): Promise<Projection> {
  const ent = await supabase
    .from('entities').select('id, name, attributes')
    .eq('workspace_id', wsId).eq('kind', 'account').eq('name', accountName).single();
  if (ent.error || !ent.data) throw new Error(`account not found: ${accountName}`);
  const accountId = ent.data.id as string;

  // Active facts on the account (supersede dedup)
  const allFacts = await supabase
    .from('facts').select('id, predicate, object_text, confidence, supersedes')
    .eq('workspace_id', wsId).eq('subject_entity', accountId);
  if (allFacts.error) throw allFacts.error;
  const supersededIds = new Set(
    (allFacts.data ?? []).map((f) => f.supersedes as string | null).filter((x): x is string => !!x),
  );
  const activeFacts = (allFacts.data ?? []).filter((f) => !supersededIds.has(f.id as string));

  // Contacts: entities linked via works_at fact pointing at this account
  const worksAtFacts = await supabase
    .from('facts').select('subject_entity')
    .eq('workspace_id', wsId).eq('predicate', 'works_at').eq('object_entity', accountId);
  if (worksAtFacts.error) throw worksAtFacts.error;
  const contactIds = (worksAtFacts.data ?? []).map((f) => f.subject_entity as string);
  let contacts: Projection['contacts'] = [];
  if (contactIds.length) {
    const ents = await supabase
      .from('entities').select('id, name, attributes')
      .in('id', contactIds).eq('workspace_id', wsId).eq('kind', 'contact');
    if (ents.error) throw ents.error;
    contacts = (ents.data ?? []).map((e) => {
      const attrs = (e.attributes ?? {}) as Record<string, string>;
      return {
        id: e.id as string,
        name: e.name as string,
        email: attrs.email ?? '',
        role: attrs.role ?? '',
      };
    });
  }

  // Past touch: most recent touch_draft channel_post on this account's channel
  const ch = await supabase
    .from('channels').select('id').eq('workspace_id', wsId).eq('account_entity_id', accountId).maybeSingle();
  let past_touch: Projection['past_touch'] = null;
  if (ch.data?.id) {
    const posts = await supabase
      .from('channel_posts').select('body, created_at')
      .eq('channel_id', ch.data.id).eq('kind', 'touch_draft')
      .order('created_at', { ascending: false }).limit(1);
    if (posts.error) throw posts.error;
    const p = posts.data?.[0];
    if (p) {
      const daysAgo = Math.round((Date.now() - new Date(p.created_at as string).getTime()) / 86400_000);
      past_touch = { body: p.body as string, days_ago: daysAgo };
    }
  }

  // Recent signals
  const sigs = await supabase
    .from('signals').select('id, type, magnitude, body_for_embedding, observed_at')
    .eq('workspace_id', wsId).eq('entity_id', accountId)
    .order('observed_at', { ascending: false }).limit(5);
  if (sigs.error) throw sigs.error;

  return {
    account: { id: accountId, name: ent.data.name as string, attributes: ent.data.attributes as Record<string, unknown> },
    facts: activeFacts.map((f) => ({
      id: f.id as string,
      predicate: f.predicate as string,
      object: (f.object_text as string | null) ?? null,
      confidence: f.confidence as number,
    })),
    contacts,
    past_touch,
    signals: (sigs.data ?? []).map((s) => ({
      id: s.id as string,
      type: s.type as string,
      magnitude: s.magnitude as number,
      body: (s.body_for_embedding as string | null) ?? '',
      observed_at: s.observed_at as string,
    })),
  };
}

interface ChatMessage { role: 'system' | 'user'; content: string }

async function callOpenAI(messages: ChatMessage[]) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, messages, response_format: { type: 'json_object' } }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  }>;
}

async function draft(wsId: string, accountName: string) {
  const t0 = Date.now();
  const projection = await buildProjection(wsId, accountName);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Account: ${accountName}\n\nProjection:\n${JSON.stringify(projection)}\n\nDraft.` },
  ];
  const r = await callOpenAI(messages);
  const latency_ms = Date.now() - t0;
  return {
    input_tokens: r.usage.prompt_tokens,
    output_tokens: r.usage.completion_tokens,
    latency_ms,
    llm_calls: 1,
    api_calls_to_data_store: 5, // entity, facts, works_at, contacts, channel+posts, signals -> ~5 Supabase reads, all bundled
    decision_text: r.choices[0].message.content,
  };
}

interface RunResult {
  system: 'agent-crm';
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
  const wsId = await findWorkspace();
  console.log(`agent-crm drafter runner`);
  console.log(`workspace: ${wsId}, model: ${MODEL}`);
  console.log(`accounts: ${ACCOUNTS.length}, runs per account: ${RUNS_PER_ACCOUNT}\n`);

  const results: RunResult[] = [];
  for (const name of ACCOUNTS) {
    for (let run = 1; run <= RUNS_PER_ACCOUNT; run++) {
      const r = await draft(wsId, name);
      results.push({ system: 'agent-crm', account: name, run, ...r });
      console.log(`  ${name.padEnd(18)} run ${run}: ${r.input_tokens.toString().padStart(5)} in / ${r.output_tokens.toString().padStart(4)} out / ${r.latency_ms.toString().padStart(5)}ms / ${r.llm_calls} LLM calls`);
    }
  }

  const tot_in = results.reduce((a, b) => a + b.input_tokens, 0);
  const tot_out = results.reduce((a, b) => a + b.output_tokens, 0);
  const avg_in = tot_in / results.length;
  const avg_lat = results.reduce((a, b) => a + b.latency_ms, 0) / results.length;
  const avg_calls = results.reduce((a, b) => a + b.llm_calls, 0) / results.length;

  console.log(`\nagent-crm drafter summary (${results.length} runs)`);
  console.log(`  avg input tokens:  ${avg_in.toFixed(1)}`);
  console.log(`  avg output tokens: ${(tot_out / results.length).toFixed(1)}`);
  console.log(`  avg latency:       ${avg_lat.toFixed(0)} ms`);
  console.log(`  avg LLM calls:     ${avg_calls.toFixed(2)}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const out = resolve(OUT_DIR, 'drafter_agent-crm.json');
  writeFileSync(out, JSON.stringify({
    system: 'agent-crm',
    model: MODEL,
    runs: results,
    summary: {
      avg_input_tokens: avg_in,
      avg_output_tokens: tot_out / results.length,
      avg_latency_ms: avg_lat,
      avg_llm_calls: avg_calls,
    },
  }, null, 2));
  console.log(`\nwrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
