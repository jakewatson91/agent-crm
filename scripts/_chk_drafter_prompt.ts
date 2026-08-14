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
  const build = (
    angle?: { problem: string; withheld_template_ids?: string[] },
    over: { templates?: unknown; char_budget?: number } = {},
  ) => buildSystemPrompt('drafter', ws.about, ws.constitution, ws.persona, ws.icp, {}, {
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
    templates: (over.templates ?? policy.drafter?.templates) as any,
    angle,
    message_rules: policy.drafter?.message_rules,
    char_budget: over.char_budget ?? policy.drafter?.char_budget,
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
      // The body is not the only place the exemplar's wording lives. Assert on
      // the withheld block alone, not the whole prompt: an unwithheld exemplar
      // legitimately quotes itself in its own anatomy, so a prompt-wide search
      // for a quoted span can never fail and would pin nothing.
      ['withheld anatomy quotes no sentence', !/["“][^"”]{4,}["”]/.test(
        withAngle.slice(withAngle.indexOf('EXEMPLAR: WITHHELD')).split('\n\n')[0] ?? '')],
      ['other exemplars still render', /EXEMPLAR: "/.test(withAngle)],
      ['reasoning asks for the fact behind the problem', withAngle.includes('quote the one fact')],
    ];
    for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    console.log(`system prompt: ${withAngle.length} chars`);

    // Example messages are optional. With none configured this used to fall
    // through to a 250-character connection request, so a workspace that had
    // not written any got a shorter, different message instead of the same
    // message without examples. The LENGTH decides the shape now.
    console.log('\n=== with no example messages configured ===');
    const bare = build(undefined, { templates: [] });
    const bareChecks: Array<[string, boolean]> = [
      ['still writes a DM, not a connection request', bare.includes('FILL THE MESSAGE SHAPE') && !bare.includes('FILL THE CONNECTION-REQUEST SHAPE')],
      ['the beat order is spelled out instead of taken from an example', bare.includes('The think question from STEP 3')],
      ['it still has to say what the product does before asking', bare.includes('Beat 4 is not optional')],
      ['no dangling TEMPLATES heading with nothing under it', !bare.includes('TEMPLATES —')],
      ['the reasoning field stops asking which template was chosen', !bare.includes('name the template you chose')],
      ['the product menu still renders', bare.includes('WHAT IT ACTUALLY DOES')],
    ];
    for (const [label, ok] of bareChecks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);

    // A short budget IS a connection request: LinkedIn hard-cuts one at 300.
    console.log('\n=== at connection-request length (250) ===');
    const short = build(undefined, { templates: [], char_budget: 250 });
    const shortChecks: Array<[string, boolean]> = [
      ['switches to the connection-request shape on length alone', short.includes('FILL THE CONNECTION-REQUEST SHAPE')],
      ['and drops the product sentence, since there is no room for it', !short.includes('Beat 4 is not optional')],
    ];
    for (const [label, ok] of shortChecks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  } else {
    console.log('\n(no templates or no pain_points on this workspace — angle path not exercised)');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
