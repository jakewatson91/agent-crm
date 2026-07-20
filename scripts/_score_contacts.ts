import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreAndAssert } from '@agent-crm/tools';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, policy')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!;
  const wsId = ws.id as string;

  // 1) enable contact scoring + seed personas (config, not code) — merge, don't overwrite
  const pol = (ws.policy ?? {}) as any;
  const scorable = Array.from(new Set([...(pol.scorable_types ?? ['account']), 'account', 'contact']));
  const personas = { ...(pol.personas ?? {}), target_roles: [
    'founder', 'co-?founder', '\\bceo\\b', 'chief executive', '\\bcto\\b', 'chief technology',
    'head of (sales|growth|revenue|gtm)', '\\bvp\\b (of )?(sales|growth|revenue)', 'chief revenue',
  ] };
  const newPol = { ...pol, scorable_types: scorable, personas };
  await sb.from('workspaces').update({ policy: newPol }).eq('id', wsId);
  console.log('policy updated: scorable_types =', scorable, '\n  personas.target_roles =', personas.target_roles.length, 'patterns');

  // 2) all contact entity ids (is_a=contact active)
  const facts: any[] = [];
  for (let from = 0; ; from += 1000) { const rows = ((await sb.from('facts').select('subject_entity, object_text, supersedes').eq('workspace_id', wsId).eq('predicate', 'is_a').is('supersedes', null).range(from, from + 999)).data ?? []) as any[]; facts.push(...rows); if (rows.length < 1000) break; }
  const contactIds = facts.filter((f) => f.object_text === 'contact').map((f) => f.subject_entity);
  console.log(`\nscoring ${contactIds.length} contacts...`);

  const actor = { workspace_id: wsId, actor_kind: 'agent' as const, actor_id: 'system:contact-scorer' };
  let scored = 0, skipped = 0;
  for (const id of contactIds) {
    const r = await scoreAndAssert(sb, actor, id);
    if (r) scored++; else skipped++;
  }
  console.log(`scored ${scored} | skipped ${skipped} (stale/gated)`);
}
main().catch((e) => { console.error('✗', e instanceof Error ? e.message : e); process.exit(1); });
