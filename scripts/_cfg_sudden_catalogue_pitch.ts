/**
 * Sudden's pitch was aimed at the wrong traffic.
 *
 * Every draft was arguing "your premiere spikes, so let us carry the premiere".
 * That is backwards twice over. A premiere is the one thing a CTO will not put a
 * new delivery path in front of, and it is not where the unwanted cost is. The
 * real argument: a new release sends viewers back through the OLD seasons and
 * related titles, and that catch-up traffic is what they are paying to serve
 * again and again with none of the reason they paid for the premiere. It is also
 * the safe place to start, because nothing about the launch has to change.
 *
 * The launch stays the anchor — it is the dated event and the reason to write.
 * What changes is what the message says the launch CAUSES.
 *
 * Config only. No code, nothing vertical-specific outside this workspace.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

const PAIN_POINTS = [
  'A new season or film sends viewers back through the older seasons and related titles, so the delivery bill grows most on catalogue you have already paid to serve many times over',
  'Catch-up viewing on old titles costs the same per view as the premiere and carries none of the reason you paid for the premiere',
  'Ads pay a fixed amount per view while every extra view costs more to deliver, so a catalogue that keeps growing quietly eats the margin',
  'Nobody on the team owns what the back catalogue costs to deliver, so it grows without anyone deciding it should',
];

const VALUE_PROPS = [
  'You can put it on the back catalogue on its own and leave your premieres exactly as they are',
  'Stops you sending the same video out over and over when a lot of people are working through the same episodes at once',
  'It is a small piece of code in your player. Your CDN, your origin and your encoding all stay exactly as they are',
  'You watch the drop happen in your own CDN dashboard, so you do not have to take our word for it',
  'If two viewers cannot reach each other, it quietly falls back to your CDN',
  'Nobody on the video team has to look after it',
];

// Appended to the existing constitution rather than replacing it: the two
// allowed credibility claims and the no-pricing-in-a-first-message rule are
// still right and were not the problem.
const PITCH_RULE = `
A new release is the REASON to write, never the thing to sell against. What we reduce is the catalogue traffic a release drives: people going back through earlier seasons and related titles once the new one lands. Write about that traffic, not about the premiere's own audience.

Never propose putting a premiere, a live event or a tentpole launch on us. The offer is always the catalogue. That is where the cost they resent actually sits, and it is the safe place to start, because nothing about the launch itself changes.`;

(async () => {
  const { data, error } = await sb.from('workspaces').select('policy, constitution').eq('id', WS).maybeSingle();
  if (error) throw error;
  const policy = ((data as any)?.policy ?? {}) as Record<string, any>;
  const constitution = String((data as any)?.constitution ?? '');

  console.log('BEFORE');
  console.log('  pain_points:', (policy.drafter?.pain_points ?? []).length);
  console.log('  value_props:', (policy.drafter?.value_props ?? []).length);
  console.log('  constitution:', constitution.length, 'chars');

  if (constitution.includes('never the thing to sell against')) {
    console.log('\nconstitution already carries the pitch rule — not appending twice');
  }

  const next = {
    ...policy,
    drafter: { ...(policy.drafter ?? {}), pain_points: PAIN_POINTS, value_props: VALUE_PROPS },
  };
  const nextConstitution = constitution.includes('never the thing to sell against')
    ? constitution
    : `${constitution.trim()}\n${PITCH_RULE}`;

  const upd = await sb.from('workspaces')
    .update({ policy: next, constitution: nextConstitution })
    .eq('id', WS);
  if (upd.error) throw upd.error;

  console.log('\nAFTER');
  console.log('  pain_points:');
  for (const p of PAIN_POINTS) console.log(`    - ${p}`);
  console.log('  value_props:');
  for (const v of VALUE_PROPS) console.log(`    - ${v}`);
  console.log(`  constitution: ${nextConstitution.length} chars`);
})().catch((e) => { console.error(e); process.exit(1); });
