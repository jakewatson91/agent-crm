/**
 * Adds enricher coverage for research_result signals (Exa-sourced research,
 * structured_tags.signal_source === 'research'). Today only one enricher is
 * active workspace-wide (relevant_hires_enricher, filtered to kind=hiring),
 * so research signals never produce facts or trigger a re-score — confirmed
 * via the live subscriptions table and match_signal_to_subscriptions.
 *
 * semantic_query is built from workspaces.about + workspaces.icp, read at
 * run time, not hand-written here — so the same script produces relevant
 * wording for any workspace's own configured business/ICP.
 *
 * Idempotent: skips if a subscription with this owner_id already exists.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { callTool } from '@agent-crm/tools';

const OWNER_ID = 'research_signal_enricher';
const THRESHOLD = 0.3; // see scripts/_tune_research_threshold.ts — 62% of last 24h's research_result signals clear this

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = await sb.from('workspaces').select('id, name, about, icp')
    .order('created_at', { ascending: false }).limit(1).single();
  if (ws.error || !ws.data) throw new Error(`no workspace: ${ws.error?.message}`);
  console.log(`workspace: ${ws.data.name} (${ws.data.id})`);

  const existing = await sb.from('subscriptions').select('id, active')
    .eq('workspace_id', ws.data.id).eq('owner_id', OWNER_ID).maybeSingle();
  if (existing.data) {
    console.log(`already exists: id=${existing.data.id} active=${existing.data.active}`);
    return;
  }

  // Truncate `about` BEFORE assembling, not the joined string after. Workspaces
  // commonly have a multi-thousand-char `about`; slicing the final string would
  // land mid-`about` and drop the pain-points + "look for..." instruction that
  // actually tells the model what to watch for. Cap `about` so the rest survives.
  const about = ((ws.data.about as string) ?? '').trim().slice(0, 800);
  const icp = (ws.data.icp as Record<string, unknown>) ?? {};
  const pain = (Array.isArray((icp as any).pain) ? (icp as any).pain.join('; ') : '').slice(0, 400);

  const semanticQuery = [
    'Research findings worth recording as facts about a prospective account.',
    about ? `This business: ${about}` : '',
    pain ? `Watch especially for signals matching these pain points: ${pain}.` : '',
    'Look for funding events, leadership or hiring changes, product launches, pricing or tooling changes, customer wins or losses, and any stated operational pain.',
  ].filter(Boolean).join(' ');

  const actor = { workspace_id: ws.data.id as string, actor_kind: 'system' as const, actor_id: 'setup:research_enricher' };
  const created = await callTool(sb, actor, 'create_subscription', {
    owner_kind: 'agent',
    owner_id: OWNER_ID,
    name: 'Research signal enricher',
    semantic_query: semanticQuery,
    structured_filter: { signal_source: 'research' },
    threshold: THRESHOLD,
    action_on_match: 'agent.run',
  });
  if (!created.ok) { console.error('create failed:', created.error); process.exit(1); }

  // agent_behavior isn't in the create_subscription tool schema yet — same
  // post-create patch as relevant_hires_enricher and the old catch-all.
  const upd = await sb.from('subscriptions').update({ agent_behavior: 'enricher' })
    .eq('id', created.target_id)
    .select('id, name, threshold, agent_behavior, structured_filter, semantic_query');
  if (upd.error) { console.error('agent_behavior update failed:', upd.error.message); process.exit(1); }
  console.log('created:', JSON.stringify(upd.data?.[0], null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
