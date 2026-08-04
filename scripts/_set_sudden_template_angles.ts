/**
 * Record what each template's exemplar ARGUES, so the angle picker can withhold
 * the ones that argue what the message is about to argue.
 *
 * `audience` says who the message is for. Nothing said what it argued, so
 * choosing an audience silently chose an argument — MBC Group picked template 2
 * and shipped a synonym swap of template 2's question. Rewriting the exemplars
 * into freight (_set_sudden_exemplars.ts) killed word-for-word copying but not
 * this: the freight body asks whether cost per LOAD falls as lanes grow, and the
 * model transposes it back to cost per viewer without reusing a word.
 *
 * These sentences describe the argument in plain, industry-neutral terms,
 * because the picker compares them against the workspace's pain_points, which
 * are also written that way. They are not rendered to the drafter.
 *
 * Only `angle` changes. Bodies, anatomy, audience and enabled are untouched.
 *
 * Usage: tsx scripts/_set_sudden_template_angles.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

const ANGLES: Record<string, string> = {
  // Asks the recipient to extend their own published analysis. It argues no
  // problem at all, so it collides with nothing and always renders in full.
  t1_connectors: 'No problem argued: asks the recipient to extend their own published analysis one step further.',
  t2_founder: 'Unit cost does not fall as the business grows — the bill tracks volume one for one.',
  t3_technical: 'A large, measurable share of what they already pay for is waste, and nobody on the team can see that share broken out.',
  // Disabled today. Tagged anyway: re-enabling it without an angle would put an
  // untagged, copyable exemplar back in front of the model.
  t4_discovery: 'Unit cost climbs with every unit added, and the waste line grows with the network.',
};

async function main() {
  const { data: w, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const policy = (w!.policy ?? {}) as Record<string, unknown>;
  const drafter = (policy.drafter ?? {}) as Record<string, unknown>;
  const templates = (drafter.templates ?? []) as Array<Record<string, unknown>>;
  if (!templates.length) throw new Error('no templates on policy.drafter — run _set_sudden_templates.ts first');

  const next = templates.map((t) => {
    const angle = ANGLES[String(t.id)];
    return angle ? { ...t, angle } : t;
  });
  policy.drafter = { ...drafter, templates: next };

  const { error: upErr } = await sb.from('workspaces').update({ policy }).eq('id', WS);
  if (upErr) throw upErr;

  for (const t of next) {
    const angle = t.angle ? String(t.angle) : '(none — exemplar always renders in full)';
    console.log(`${String(t.id).padEnd(16)} ${t.enabled === false ? '[disabled] ' : ''}${angle}`);
  }
  console.log('\nNo rescore needed: templates are drafter-only, not a scoring input.');
}
main().catch((e) => { console.error(e); process.exit(1); });
