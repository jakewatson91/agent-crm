import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { buildDrafterDecision } from '../packages/tools/src/prompt_builders.ts';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS='e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main(){
  const { data: w } = await sb.from('workspaces').select('policy').eq('id',WS).single();
  const p:any = (w!.policy as any).drafter ?? {};
  const withArg = buildDrafterDecision({
    outreach_channel: 'email', subject_style: p.subject_style, paragraph_count: p.paragraph_count,
    pain_points: p.pain_points, value_props: p.value_props, forbidden_field_terms: p.forbidden_field_terms,
    out_of_scope: p.out_of_scope, trigger_fresh_days: p.trigger_fresh_days,
    angle: { problem: '', argument: p.arguments?.[0] },
  } as any);
  const bare = buildDrafterDecision({ outreach_channel: 'email' } as any);
  const suddenNoArg = buildDrafterDecision({
    outreach_channel: 'email', subject_style: p.subject_style, paragraph_count: p.paragraph_count,
    pain_points: p.pain_points, value_props: p.value_props, forbidden_field_terms: p.forbidden_field_terms,
    out_of_scope: p.out_of_scope, trigger_fresh_days: p.trigger_fresh_days,
  } as any);
  const words = (s:string)=>s.split(/\s+/).length;
  console.log('BARE new workspace (email, no config):', bare.length, 'chars ~', words(bare), 'words ~', Math.round(bare.length/4), 'tokens');
  console.log('SUDDEN no argument            :', suddenNoArg.length, 'chars ~', Math.round(suddenNoArg.length/4), 'tokens');
  console.log('SUDDEN with argument          :', withArg.length, 'chars ~', Math.round(withArg.length/4), 'tokens');
  console.log('\nshare of the bare prompt that is fixed craft (shared by every workspace):', (bare.length/suddenNoArg.length*100).toFixed(0)+'%');
  // count instruction lines / imperative rules in the shared craft
  const craftLines = bare.split('\n').filter(l=>l.trim().length>0);
  console.log('non-empty lines in a bare prompt:', craftLines.length);
  const rules = bare.split('\n').filter(l=>/^\s*[-•]/.test(l)).length;
  console.log('bulleted rules:', rules);
  console.log('STEP headings:', (bare.match(/STEP \d/g)??[]).length);
  // sentences containing MUST/NEVER/DO NOT/NEVER
  const hard = (bare.match(/NEVER|MUST|DO NOT|Do not|Never|BANNED|banned/g)??[]).length;
  console.log('hard prohibitions (NEVER/MUST/DO NOT tokens):', hard);
}
main();
