/**
 * One-time: ATS hiring source + hiring_filter + relevant-hires enricher for
 * Sudden. See ~/.claude/plans/squishy-imagining-harp.md item 6. This mirrors
 * infra that's already self-serve (Settings->Sources for the connector,
 * Settings->Workspace for hiring_filter) — only the semantic enricher
 * subscription has no UI yet, hence the script for that piece.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { callTool } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const actor = { workspace_id: WS, actor_kind: 'system' as const, actor_id: 'sudden_ats_setup_script' };

async function main() {
  const { data: w } = await sb.from('workspaces').select('policy').eq('id', WS).maybeSingle();
  const policy = (w?.policy ?? {}) as Record<string, any>;
  const painPoints: string[] = policy.drafter?.pain_points ?? [];
  const valueProps: string[] = policy.drafter?.value_props ?? [];

  // 1. ATS source — same connector_type + shape the Sources UI would create.
  // max_entities_per_run raised from the 200 default: free connector, no
  // credit risk, so no reason to throttle first-coverage across 1961 accounts.
  const src = await sb.from('sources').insert({
    workspace_id: WS,
    connector_type: 'ats',
    name: 'ATS hiring (video delivery eng)',
    config: {
      providers: ['greenhouse', 'lever', 'ashby', 'workable'],
      reprobe_days: 30,
      max_entities_per_run: 500,
    },
    schedule_cron: '0 13 * * *',
    active: true,
  }).select('id').single();
  if (src.error) throw src.error;
  console.log('✓ ats source created:', src.data.id);

  // 2. Coarse role-family pre-filter — same field the Settings->Workspace UI
  // writes to (settings/workspace/page.tsx). Cuts non-engineering hires
  // before they become signals at all.
  const nextPolicy = {
    ...policy,
    hiring_filter: { ...(policy.hiring_filter ?? {}), include_families: ['engineering'] },
  };
  const polUpd = await sb.from('workspaces').update({ policy: nextPolicy }).eq('id', WS);
  if (polUpd.error) throw polUpd.error;
  console.log('✓ hiring_filter.include_families = [engineering]');

  // 3. Semantic enricher — the actual "video delivery engineering" precision,
  // grounded in Sudden's own configured pitch (read from policy above, not
  // invented), same pattern as dogfood's relevant_hires_enricher.
  const semanticQuery = [
    'A job posting that signals this company is scaling video delivery, streaming, or CDN infrastructure — ',
    'roles like video delivery engineer, streaming infrastructure engineer, CDN engineer, media/encoding/transcoding engineer, video platform engineer, or similar.',
    painPoints.length ? `\n\nWhy this matters for us: ${painPoints.join('; ')}.` : '',
    valueProps.length ? `\n\nWhat we offer: ${valueProps.join('; ')}.` : '',
  ].join('');

  const enricherSub = await callTool(sb, actor, 'create_subscription', {
    owner_kind: 'agent',
    owner_id: 'relevant_hires_enricher',
    name: 'Relevant hires (video delivery engineering)',
    semantic_query: semanticQuery,
    structured_filter: { kind: 'hiring' },
    threshold: 0.5,
    action_on_match: 'agent.run',
  });
  if (enricherSub.ok) {
    await sb.from('subscriptions').update({ agent_behavior: 'enricher' }).eq('id', enricherSub.target_id);
    console.log('✓ relevant_hires_enricher subscription created:', enricherSub.target_id);
  } else {
    console.log('✗ relevant_hires_enricher subscription failed:', enricherSub.error);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
