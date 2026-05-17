/**
 * Token-cost benchmark runner: agent-crm side.
 *
 * For each account, load a tight decision-context projection (facts + signals + cites)
 * via a single shaped query, hand it to Claude Haiku, and capture token usage.
 *
 * The point: pre-projection means the agent reads exactly what's needed and nothing more.
 * No raw object dumps, no second round trips, no re-reading prior turns.
 *
 * Usage:
 *   WS=<workspace_uuid> pnpm tsx benchmark/runners/agent-crm/run.ts
 *   (omit WS to auto-discover the most recent `demo · agent-crm` workspace)
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../../metrics');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const MODEL = 'gpt-4o-mini';
const RUNS_PER_ACCOUNT = 3;
const ACCOUNTS = ['Resona Labs', 'Forge Robotics', 'Plaintext.so', 'Halo Health', 'Brightvine', 'Strand Compute'];

const SYSTEM_PROMPT = `You are an outbound-touch decision agent.
Given an account context, decide whether to send an outbound touch this week.
Output strictly valid JSON: {"decide": boolean, "reasoning": string, "citations": string[]}
- decide: true if a touch is warranted given the signals and ICP fit; false otherwise.
- reasoning: 1-2 sentences referencing specific account context.
- citations: array of fact_ids or signal_ids you relied on.`;

interface DecisionContext {
  account: { id: string; name: string; attributes: Record<string, unknown> };
  facts: Array<{ id: string; predicate: string; object: string | null; confidence: number }>;
  signals: Array<{ id: string; type: string; magnitude: number; body: string; observed_at: string }>;
}

async function findWorkspace(): Promise<string> {
  if (process.env.WS) return process.env.WS;
  const { data, error } = await supabase
    .from('workspaces')
    .select('id, created_at')
    .like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data?.length) throw new Error('No demo workspace found. Run `pnpm seed` first.');
  return data[0]!.id as string;
}

async function loadDecisionContext(ws: string, accountName: string): Promise<DecisionContext> {
  const ent = await supabase
    .from('entities')
    .select('id, name, attributes')
    .eq('workspace_id', ws)
    .eq('kind', 'account')
    .eq('name', accountName)
    .single();
  if (ent.error || !ent.data) throw new Error(`account not found: ${accountName}`);

  // Active facts = the latest in each supersede chain = facts whose id is not
  // referenced by any other fact's `supersedes` column. Filtering on
  // `supersedes is null` is WRONG: it returns original facts only and drops
  // every newer fact that replaced an older one.
  const allFacts = await supabase
    .from('facts')
    .select('id, predicate, object_text, confidence, supersedes')
    .eq('workspace_id', ws)
    .eq('subject_entity', ent.data.id);
  if (allFacts.error) throw allFacts.error;
  const supersededIds = new Set(
    (allFacts.data ?? []).map((f) => f.supersedes as string | null).filter((x): x is string => !!x),
  );
  const facts = {
    error: null as null,
    data: (allFacts.data ?? []).filter((f) => !supersededIds.has(f.id as string)),
  };

  const signals = await supabase
    .from('signals')
    .select('id, type, magnitude, body_for_embedding, observed_at')
    .eq('workspace_id', ws)
    .eq('entity_id', ent.data.id)
    .order('observed_at', { ascending: false })
    .limit(20);
  if (signals.error) throw signals.error;

  return {
    account: { id: ent.data.id as string, name: ent.data.name as string, attributes: ent.data.attributes as Record<string, unknown> },
    facts: (facts.data ?? []).map((f) => ({
      id: f.id as string,
      predicate: f.predicate as string,
      object: (f.object_text as string | null) ?? null,
      confidence: f.confidence as number,
    })),
    signals: (signals.data ?? []).map((s) => ({
      id: s.id as string,
      type: s.type as string,
      magnitude: s.magnitude as number,
      body: (s.body_for_embedding as string | null) ?? '',
      observed_at: s.observed_at as string,
    })),
  };
}

async function decide(ctx: DecisionContext) {
  const userMsg = `ACCOUNT CONTEXT:\n${JSON.stringify(ctx, null, 2)}\n\nDecide.`;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');

  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
    }),
  });
  const latency_ms = Date.now() - t0;
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  const json = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };
  return {
    input_tokens: json.usage.prompt_tokens,
    output_tokens: json.usage.completion_tokens,
    latency_ms,
    decision_text: json.choices[0]?.message.content ?? '',
  };
}

interface RunResult {
  system: 'agent-crm';
  account: string;
  run: number;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  api_calls_to_data_store: number;
  decision_text: string;
}

async function main() {
  const ws = await findWorkspace();
  console.log(`workspace: ${ws}`);
  console.log(`model: ${MODEL}`);
  console.log(`accounts: ${ACCOUNTS.length}, runs per account: ${RUNS_PER_ACCOUNT}\n`);

  const results: RunResult[] = [];

  for (const accountName of ACCOUNTS) {
    const ctx = await loadDecisionContext(ws, accountName);  // 3 supabase calls per account
    for (let run = 1; run <= RUNS_PER_ACCOUNT; run++) {
      const r = await decide(ctx);
      results.push({
        system: 'agent-crm',
        account: accountName,
        run,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        latency_ms: r.latency_ms,
        api_calls_to_data_store: 3,
        decision_text: r.decision_text,
      });
      console.log(`  ${accountName.padEnd(18)} run ${run}: ${r.input_tokens.toString().padStart(5)} in / ${r.output_tokens.toString().padStart(4)} out / ${r.latency_ms.toString().padStart(5)}ms`);
    }
  }

  const tot_in = results.reduce((a, b) => a + b.input_tokens, 0);
  const tot_out = results.reduce((a, b) => a + b.output_tokens, 0);
  const avg_in = tot_in / results.length;
  const avg_lat = results.reduce((a, b) => a + b.latency_ms, 0) / results.length;

  console.log(`\nagent-crm summary (${results.length} runs)`);
  console.log(`  avg input tokens:  ${avg_in.toFixed(1)}`);
  console.log(`  avg output tokens: ${(tot_out / results.length).toFixed(1)}`);
  console.log(`  avg latency:       ${avg_lat.toFixed(0)} ms`);

  mkdirSync(OUT_DIR, { recursive: true });
  const out = resolve(OUT_DIR, 'token_cost_agent-crm.json');
  writeFileSync(out, JSON.stringify({ system: 'agent-crm', model: MODEL, runs: results, summary: { avg_input_tokens: avg_in, avg_output_tokens: tot_out / results.length, avg_latency_ms: avg_lat } }, null, 2));
  console.log(`\nwrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
