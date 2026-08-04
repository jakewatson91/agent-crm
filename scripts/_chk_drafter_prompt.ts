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
  const build = (angle?: { problem: string; withheld_template_ids?: string[] }) => buildSystemPrompt('drafter', ws.about, ws.constitution, ws.persona, ws.icp, {}, {
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
    angle,
    message_rules: policy.drafter?.message_rules,
    char_budget: policy.drafter?.char_budget,
    trigger_max_age_days: policy.drafter?.trigger_max_age_days,
    trigger_fresh_days: policy.drafter?.trigger_fresh_days,
    out_of_scope: policy.drafter?.out_of_scope,
  });

  const sys = build();
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

  // Same prompt with an angle picked. Two things must be true or the whole
  // point of the change is gone: the chosen problem replaces the menu, and the
  // withheld template's exemplar body is not in the prompt anywhere.
  const templates = (policy.drafter?.templates ?? []) as Array<{ id: string; body: string; enabled?: boolean }>;
  const victim = templates.find((t) => t.enabled !== false && t.body?.trim());
  const pains = (policy.drafter?.pain_points ?? []) as string[];
  if (victim && pains.length) {
    console.log(`\n=== with an angle picked (problem 1, withholding ${victim.id}) ===`);
    const withAngle = build({ problem: pains[0]!, withheld_template_ids: [victim.id] });
    const checks: Array<[string, boolean]> = [
      ['chosen problem replaces the menu', withAngle.includes('THE PROBLEM YOU ARE WRITING TO') && !withAngle.includes('PROBLEMS WE SOLVE')],
      [`${victim.id} exemplar body is gone`, !withAngle.includes(victim.body.slice(0, 60))],
      ['withheld notice renders', withAngle.includes('EXEMPLAR: WITHHELD')],
      ['other exemplars still render', /EXEMPLAR: "/.test(withAngle)],
      ['reasoning asks for the fact behind the problem', withAngle.includes('quote the one fact')],
    ];
    for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    console.log(`system prompt: ${withAngle.length} chars`);
  } else {
    console.log('\n(no templates or no pain_points on this workspace — angle path not exercised)');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
