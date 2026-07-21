// Sudden drafter config, rebuilt from Jake's 4T doc.
//
// The old constitution said "Always lead with direct cost reduction ... Emphasize
// the risk-free pricing model" and it rendered ABOVE the templates in the system
// prompt, so the model obeyed it and produced ten pitch-first DMs in a row, all
// rejected at the send approval. The general craft (trigger test, think question,
// CTA taxonomy, line edit) now lives in code as OUTREACH_CRAFT in
// packages/tools/src/prompt_builders.ts. What's left here is only what is
// specific to THIS workspace: what Sudden is allowed to claim, and when.
//
// value_props / pain_points also feed account scoring (packages/tools/src/scoring.ts)
// and research direction (packages/tools/src/research_strategy.ts), so they are
// written as what is true, not as what sells.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

const CONSTITUTION = [
  'Two credibility claims are allowed and no others: that delivery cost usually grows one to one with audience, and that delivery is about 98 percent of streaming infrastructure spend, per AWS’s own VOD table.',
  'The 60 to 80 percent savings figure and the pay-from-savings pricing do not go in a first message. They come up only after the person replies.',
  'Never criticize their CDN or their engineering choices.',
].join(' ');

const VALUE_PROPS = [
  'Offloads a share of video delivery between viewers already watching, so the CDN serves less',
  'Drops in as a script plus a service worker, with no change to CDN, player, origin or encoding',
  "Offload percentage shows up in the customer's own CDN dashboard, so they can verify it themselves",
  "Falls back to the CDN automatically when a direct connection can't be made",
];

const PAIN_POINTS = [
  'Delivery cost per viewer never falls; the cost line grows one to one with the audience',
  'A large share of egress is the same segments served over and over, and most teams cannot see that share',
  'Traffic is scaling faster than the video delivery team can be staffed',
  'Delivery is the dominant line on the infrastructure bill and spikes on every release',
];

// Workspace-specific only. The general rules moved into OUTREACH_CRAFT.
const MESSAGE_RULES = [
  'Aim for under 400 characters (about 50 to 75 words). Template 3 may run to ~420 when the service-worker detail earns its keep with a technical buyer.',
  'The only two credibility claims available: delivery cost usually grows one to one with audience, and delivery is about 98 percent of streaming infrastructure spend (AWS’s own VOD table). Do not reach for a third.',
  'Never put the 60 to 80 percent savings figure or the pay-from-savings pricing in a first message.',
];

async function main() {
  const sb = createServerClient();
  const { data, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const policy = (data?.policy ?? {}) as Record<string, unknown>;
  const drafter = {
    ...((policy.drafter as Record<string, unknown>) ?? {}),
    value_props: VALUE_PROPS,
    pain_points: PAIN_POINTS,
    message_rules: MESSAGE_RULES,
  };
  const { error: upErr } = await sb
    .from('workspaces')
    .update({ policy: { ...policy, drafter }, constitution: CONSTITUTION })
    .eq('id', WS);
  if (upErr) throw upErr;
  console.log('Sudden drafter config rebuilt.');
  console.log(`  constitution: ${CONSTITUTION.length} chars`);
  console.log(`  value_props: ${VALUE_PROPS.length}  pain_points: ${PAIN_POINTS.length}  message_rules: ${MESSAGE_RULES.length}`);
  console.log(`  templates untouched: ${(drafter.templates as unknown[] | undefined)?.length ?? 0}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
