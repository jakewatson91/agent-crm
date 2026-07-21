/** Render the drafter decision block with exactly the fields the fixed call
 * site now passes from live Sudden policy, and confirm templates drive it. */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { buildDrafterDecision } from '@agent-crm/tools';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: w } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  const policy = (w!.policy ?? {}) as any;
  const block = buildDrafterDecision({
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
  });
  console.log('TEMPLATED PATH:', block.includes('STEP 7 — PICK ONE TEMPLATE'));
  console.log('craft block present:', block.includes('STEP 1 — FIND THE TRIGGER'));
  console.log('CTA ban present:', block.includes('Open to a quick chat?'));
  console.log('t1 present:', block.includes('t1_connectors') || block.includes('For connectors'));
  console.log('t3 present:', block.includes('Verified technical owner'));
  console.log('t4 excluded (disabled):', !block.includes('kept for reference'));
  console.log('value_props leak (60):', block.includes('60–80') || block.includes('60-80'));
  console.log('\n--- first 1200 chars ---\n' + block.slice(0, 1200));
}
main().catch((e) => { console.error(e); process.exit(1); });
