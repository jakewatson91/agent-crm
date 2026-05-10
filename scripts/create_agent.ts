/**
 * NL-driven subscription creator.
 *
 * Takes a plain-English description and produces a structured subscription row
 * via create_subscription. The meta-agent (gpt-4o-mini) infers owner_id, name,
 * semantic_query, structured_filter, and threshold from the description.
 *
 * Usage:
 *   pnpm agent:new "watch for pricing-page changes at B2B SaaS companies"
 *   WS=<id> pnpm agent:new "..." (override workspace; auto-discovers latest demo otherwise)
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { callTool } from '@agent-crm/tools';

const META_MODEL = 'gpt-4o-mini';

const META_PROMPT = `You convert a user's plain-English description of an agent into a subscription row for an agent-native CRM.

Output strictly JSON, no preamble:
{
  "name": "<snake_case_label, max 50 chars>",
  "owner_id": "claims_<distinctive_noun_phrase>",
  "semantic_query": "<one clear sentence; preserve the user's specific terminology>",
  "structured_filter": <jsonb object — see rules>,
  "threshold": <0.30–0.60>,
  "action_on_match": "agent.run"
}

Rules for owner_id:
- MUST start with "claims_" and be lowercase snake_case.
- MUST include the distinctive nouns from the user's description.
- WRONG: user says "watch X posts from ICP companies" -> "claims_icp_companies" (drops "x_posts")
- RIGHT: user says "watch X posts from ICP companies" -> "claims_x_posts_from_icp_companies"

Rules for structured_filter:
- Keys are FREEFORM. Pick keys an ingest worker would actually tag a signal with.
- Known signal_source values: "pricing_page", "careers_page", "github", "hn", "yc_directory", "product_hunt", "sec_edgar".
- For sources NOT in that list (X/Twitter, LinkedIn, Reddit, Slack, Discord, blog RSS, etc.), INVENT a sensible signal_source value (e.g. "x", "linkedin", "reddit", "rss"). Do NOT force-fit to the known list.
- If no clear signal source, return structured_filter: {}.
- DO NOT emit empty objects as values: {industry: {}} is wrong.

Rules for semantic_query:
- Preserve the user's specific terminology. If they said "X posts," keep "X posts."

Rules for threshold:
- 0.40 default; 0.30 for broad; 0.55 for narrow.

Examples:

User: "watch X posts from companies in our ICP"
Output: {"name":"x_posts_from_icp_companies","owner_id":"claims_x_posts_from_icp_companies","semantic_query":"X posts mentioning or written by companies that match our ICP","structured_filter":{"signal_source":"x"},"threshold":0.40,"action_on_match":"agent.run"}

User: "flag drafts that mention HIPAA without a citation"
Output: {"name":"hipaa_compliance_critic","owner_id":"claims_hipaa_unsourced_drafts","semantic_query":"outbound drafts that reference HIPAA, BAA, or healthcare compliance without sourcing","structured_filter":{"signal_type":"touch_draft"},"threshold":0.50,"action_on_match":"agent.run"}

User: "watch for product launches by stealth-mode YC startups in their first 90 days"
Output: {"name":"yc_stealth_launches_first_90_days","owner_id":"claims_yc_stealth_launches","semantic_query":"product launches from stealth-mode YC startups within their first 90 days","structured_filter":{"signal_source":"yc_directory"},"threshold":0.40,"action_on_match":"agent.run"}
`;

async function main() {
  const description = process.argv.slice(2).join(' ').trim();
  if (!description) {
    console.error('usage: pnpm agent:new "<plain-english description>"');
    process.exit(1);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  let WS = process.env.WS;
  if (!WS) {
    const { data, error } = await supabase
      .from('workspaces').select('id').like('name', 'demo · agent-crm%')
      .order('created_at', { ascending: false }).limit(1).single();
    if (error || !data) throw new Error('No demo workspace; run `pnpm seed` first.');
    WS = data.id as string;
  }
  console.log(`workspace: ${WS}`);
  console.log(`description: "${description}"\n`);

  console.log('1. parsing description with meta-agent…');
  const llm = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: META_MODEL,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: META_PROMPT },
        { role: 'user', content: description },
      ],
    }),
  });
  if (!llm.ok) throw new Error(`OpenAI error ${llm.status}: ${await llm.text()}`);
  const j = await llm.json() as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number; completion_tokens: number } };
  const params = JSON.parse(j.choices[0]!.message.content);

  console.log(`   tokens: ${j.usage.prompt_tokens}in / ${j.usage.completion_tokens}out`);
  console.log('   parsed:', JSON.stringify(params, null, 2));
  console.log();

  console.log('2. dispatching create_subscription…');
  const actor = { workspace_id: WS, actor_kind: 'agent' as const, actor_id: 'meta_agent_creator' };
  const r = await callTool(supabase, actor, 'create_subscription', {
    owner_kind: 'agent',
    owner_id: params.owner_id,
    name: params.name,
    semantic_query: params.semantic_query,
    structured_filter: params.structured_filter ?? {},
    threshold: params.threshold ?? 0.4,
    action_on_match: params.action_on_match ?? 'agent.run',
  });

  if (!r.ok) {
    console.error(`   ✗ ${r.error}`);
    process.exit(1);
  }
  console.log(`   ✓ subscription_id=${r.target_id}`);
  console.log(`   ✓ event_id=${r.event_id}`);

  console.log(`\nagent registered. Any signal that matches the filter above will route to "${params.owner_id}".`);
  console.log(`To trigger a run manually with a synthetic signal: pnpm exec tsx scripts/agent_smoke.ts`);
}

main().catch((e) => { console.error(e); process.exit(1); });
