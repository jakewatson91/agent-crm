/**
 * One-off: create the Sudden workspace, mirroring apps/web/app/api/workspaces/create/route.ts
 * exactly (same deriveDefaults call, same policy shape, same drafter-subscription
 * bootstrap) but invoked directly via the service-role client instead of through
 * the authenticated wizard route, since this runs outside a browser session.
 *
 * Usage: tsx scripts/_create_sudden_workspace.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { callTool } from '@agent-crm/tools';
import { deriveDefaults } from '../apps/web/app/api/workspaces/_derive_defaults';

const NAME = 'Sudden';
const ABOUT = "We're Sudden. Streaming and video companies pay a lot to serve video through their CDN, and the bill grows with every viewer they add. We built a small script customers drop into their video player. It lets viewers who are already watching share pieces of the video with each other directly, so the CDN has less to deliver. Nothing else changes: same CDN, same player, same video encoding, and it falls back automatically if a direct connection can't be made. Customers cut their CDN bill by 60 to 80 percent. We only get paid a share of what we actually save them, so no savings means no fee. We sell to media, sports, news, and gaming companies running their own streaming platform, especially bigger ones with real CDN spend. The buyer is usually a CTO or VP of Engineering.";

// Same owner as af602fa1, so Jake can log into this workspace with the same account.
const OWNER_USER_ID = 'a09d43bf-0501-4f40-9f89-d656f731f8ff';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const systemActor = {
    workspace_id: '00000000-0000-0000-0000-000000000000',
    actor_kind: 'system' as const,
    actor_id: 'wizard',
  };

  console.log('deriving defaults from about text...');
  const derived = await deriveDefaults(ABOUT);
  console.log('derived icp:', JSON.stringify(derived.icp));
  console.log('derived persona:', JSON.stringify(derived.persona));
  console.log('derived pain_points:', JSON.stringify(derived.pain_points));
  console.log('derived value_props:', JSON.stringify(derived.value_props));

  const policy: Record<string, unknown> = {
    outreach: { override_to: null, from_email: 'onboarding@resend.dev', banned_phrases: [] },
    enrichment: { contact_provider: 'none', example_facts: derived.example_facts },
    drafter: { pain_points: derived.pain_points, value_props: derived.value_props, tone_keywords: derived.tone_keywords },
  };

  const created = await callTool(sb, systemActor, 'create_workspace', {
    name: NAME,
    persona: derived.persona,
    icp: derived.icp,
    budget_cents: 1500,
    policy,
  });
  if (!created.ok) throw new Error(`create_workspace failed: ${created.error}`);
  const workspace_id = created.target_id as string;
  console.log(`created workspace: ${workspace_id}`);

  await sb.from('workspace_members').insert({ workspace_id, user_id: OWNER_USER_ID, role: 'owner' });
  console.log('added owner membership');

  await sb.from('workspaces').update({
    about: ABOUT,
    constitution: derived.constitution,
    knowledge_base: derived.knowledge_base,
  }).eq('id', workspace_id);
  console.log('set about/constitution/knowledge_base');

  const wsActor = { workspace_id, actor_kind: 'system' as const, actor_id: 'wizard' };
  const drafterSub = await callTool(sb, wsActor, 'create_subscription', {
    owner_kind: 'agent',
    owner_id: 'claims_outbound_drafter',
    name: 'outbound_drafter',
    semantic_query: 'a company worth drafting outbound to: high ICP fit, with recent news, signal, or hook worth referencing in the email',
    structured_filter: {},
    threshold: 0.40,
    action_on_match: 'agent.run',
  });
  if (!drafterSub.ok) throw new Error(`create_subscription failed: ${drafterSub.error}`);
  await sb.from('subscriptions').update({ agent_behavior: 'drafter' }).eq('id', drafterSub.target_id);
  console.log(`created drafter subscription: ${drafterSub.target_id}`);

  console.log(`\n=== Sudden workspace ready: ${workspace_id} ===`);
}

main().catch((e) => { console.error(e); process.exit(1); });
