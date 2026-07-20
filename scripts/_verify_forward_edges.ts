/**
 * Dev verification of the forward edge-write path (no Inngest dev server).
 * Creates a throwaway account, injects a relationship-rich signal, runs the REAL
 * enricher (runAgent, new code + live LLM) with resolve_entities on, and checks
 * it wrote object_entity edges. Cleans up everything it created.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { callTool } from '@agent-crm/tools';
import { runAgent } from '../inngest/functions/agent_logic.js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;

  // need an enricher subscription to run the enricher behavior
  const subs = (await sb.from('subscriptions').select('id, owner_id, owner_kind, agent_behavior, active').eq('workspace_id', ws)).data ?? [];
  console.log('subscriptions (behavior/owner/active):', (subs as any[]).map((s) => `${s.agent_behavior}/${s.owner_kind}/${s.active}`).join(', ') || '(none)');
  const enr = (subs as any[]).find((s) => s.agent_behavior === 'enricher' && s.owner_kind === 'agent' && s.active)
    ?? (subs as any[]).find((s) => s.agent_behavior === 'enricher' && s.owner_kind === 'agent')
    ?? (subs as any[]).find((s) => s.agent_behavior === 'enricher');
  if (!enr) { console.log('NO enricher subscription on af602fa1 — cannot exercise the enricher path here.'); return; }
  console.log(`using enricher sub ${enr.id.slice(0, 8)} (owner ${enr.owner_id})\n`);

  const actor = { workspace_id: ws, actor_kind: 'system' as const, actor_id: 'fwd-edge-test' };
  // cleanup any prior run
  for (const e of ((await sb.from('entities').select('id').eq('workspace_id', ws).eq('name', 'Zzztest Forward Acct')).data ?? []) as any[]) {
    await sb.from('channels').delete().eq('account_entity_id', e.id);
    await sb.from('facts').delete().eq('subject_entity', e.id);
    await sb.from('entities').delete().eq('id', e.id);
  }

  const acct = await callTool(sb, actor, 'create_entity', { name: 'Zzztest Forward Acct', kind: 'account', attributes: { domain: 'zzztest-forward.example', industry: 'b2b_saas' } });
  if (!acct.ok) throw new Error('create acct failed');
  const acctId = acct.target_id;
  // enricher posts to the account's channel; create_entity doesn't make one.
  await sb.from('channels').insert({ workspace_id: ws, account_entity_id: acctId, title: 'Zzztest Forward Acct' });

  const sig = await callTool(sb, { workspace_id: ws, actor_kind: 'agent', actor_id: 'ingest:test' }, 'create_signal', {
    entity_id: acctId, type: 'news', magnitude: 0.8,
    body_for_embedding: 'Zzztest Forward Acct announced it is now a customer of Stripe (stripe.com) and closed a Series A backed by Sequoia Capital (sequoiacap.com). The product integrates with Notion.',
    structured_tags: { signal_source: 'test' },
  });
  if (!sig.ok) throw new Error('create_signal failed');

  const beforeIds = new Set(((await sb.from('entities').select('id').eq('workspace_id', ws)).data ?? []).map((e: any) => e.id));

  console.log('running enricher…');
  const r: any = await runAgent(sb, { workspace_id: ws, agent: enr.owner_id, subscription_id: enr.id, signal_id: sig.target_id, parent_event_id: sig.event_id });
  console.log(`  ok=${r.ok} action=${r.action} reason=${r.reason ?? ''}\n`);

  const facts = (await sb.from('facts').select('id, predicate, object_text, object_entity').eq('workspace_id', ws).eq('subject_entity', acctId)).data ?? [];
  const edges = (facts as any[]).filter((f) => f.object_entity);
  const tIds = edges.map((e) => e.object_entity);
  const nm = new Map<string, string>();
  if (tIds.length) for (const e of (await sb.from('entities').select('id, name').in('id', tIds)).data ?? []) nm.set(e.id as string, e.name as string);

  console.log(`facts on test account: ${facts.length} | EDGES: ${edges.length}`);
  for (const e of edges) console.log(`  --${e.predicate}--> [${nm.get(e.object_entity) ?? e.object_entity.slice(0, 8)}]`);
  for (const f of (facts as any[]).filter((f) => !f.object_entity)) console.log(`  --${f.predicate}--> "${f.object_text}" (text)`);

  const created = ((await sb.from('entities').select('id, name, attributes').eq('workspace_id', ws)).data ?? []).filter((e: any) => !beforeIds.has(e.id));
  console.log(`\ncandidate entities created: ${created.length}`);
  for (const c of created as any[]) console.log(`  [${c.name}] candidate=${c.attributes?.candidate} domain=${c.attributes?.domain ?? 'none'}`);

  // cleanup: test account + created candidates + their facts/channels + the signal
  console.log('\ncleaning up…');
  await sb.from('channels').delete().eq('account_entity_id', acctId);
  await sb.from('facts').delete().eq('subject_entity', acctId);
  for (const c of created as any[]) { await sb.from('facts').delete().eq('subject_entity', c.id); await sb.from('channels').delete().eq('account_entity_id', c.id); }
  await sb.from('entities').delete().eq('id', acctId);
  for (const c of created as any[]) await sb.from('entities').delete().eq('id', c.id);
  await sb.from('signals').delete().eq('id', sig.target_id);
  console.log('done.');
}
main().catch((e) => { console.error(e); process.exit(1); });
