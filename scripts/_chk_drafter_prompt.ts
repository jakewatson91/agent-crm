/**
 * Read-only: print the sections of the live drafter system prompt that carry
 * CONTENT (as opposed to craft), so a config field that silently stops
 * rendering is visible instead of being discovered in a bad draft.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { buildSystemPrompt } from '../inngest/functions/agent_logic.ts';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.WORKSPACE_ID ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const { data: w } = await sb.from('workspaces').select('about, constitution, persona, icp, policy').eq('id', WS).single();
  const ws = w as Record<string, any>;
  const policy = (ws.policy ?? {}) as Record<string, any>;
  const sys = buildSystemPrompt('drafter', ws.about, ws.constitution, ws.persona, ws.icp, {}, {
    outreach_channel: policy.drafter?.outreach_channel,
    subject_style: policy.drafter?.subject_style,
    paragraph_count: policy.drafter?.paragraph_count,
    pain_points: policy.drafter?.pain_points,
    value_props: policy.drafter?.value_props,
    tone_keywords: policy.drafter?.tone_keywords,
    ask_examples: policy.drafter?.ask_examples,
    forbidden_phrases: policy.outreach?.banned_phrases ?? [],
    forbidden_field_terms: policy.drafter?.forbidden_field_terms ?? [],
    market_brief: policy.drafter?.market_brief,
    templates: policy.drafter?.templates,
    message_rules: policy.drafter?.message_rules,
    char_budget: policy.drafter?.char_budget,
    trigger_max_age_days: policy.drafter?.trigger_max_age_days,
    trigger_fresh_days: policy.drafter?.trigger_fresh_days,
    out_of_scope: policy.drafter?.out_of_scope,
  });

  const marks = ['STEP 0 —', 'PROBLEMS WE SOLVE', 'WHAT IT ACTUALLY DOES'];
  for (const m of marks) {
    const at = sys.indexOf(m);
    console.log(`${at >= 0 ? 'RENDERS' : 'MISSING'}  ${m}`);
  }
  const from = sys.indexOf('PROBLEMS WE SOLVE');
  if (from >= 0) {
    console.log('\n=== content menu as the model sees it ===');
    console.log(sys.slice(from, sys.indexOf('LEAD-FACT SELECTION')));
  }
  console.log(`system prompt: ${sys.length} chars`);
}
main().catch((e) => { console.error(e); process.exit(1); });
