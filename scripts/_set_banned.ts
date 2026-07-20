import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const w = ((await sb.from('workspaces').select('id, policy').limit(50)).data ?? []).find((x:any)=> String(x.id).startsWith('af602fa1')) as any;
  const policy = w.policy ?? {};
  policy.outreach = policy.outreach ?? {};
  const existing: string[] = policy.outreach.banned_phrases ?? [];
  // Product-specific pitch phrases moved out of shared code (BANNED_PHRASES) per
  // the config-not-code rule. Literal substrings (config path is substring, not regex).
  const productPhrases = [
    'AI-native CRM', 'AI native CRM',
    'agent-native CRM', 'agent native CRM', 'agent-native architecture',
    'agent-native platform', 'agent-native approach', 'agent-native system',
    'built for agents', 'built specifically for agents',
    'optimizes agent workflows', 'optimize agent workflows', 'optimizes agent operations',
  ];
  const merged = Array.from(new Set([...existing, ...productPhrases]));
  policy.outreach.banned_phrases = merged;
  const { error } = await sb.from('workspaces').update({ policy }).eq('id', w.id);
  if (error) { console.error('UPDATE ERROR', error.message); process.exit(1); }
  console.log('banned_phrases now:', JSON.stringify(merged, null, 1));
}
main().catch((e)=>{console.error(e.message);});
