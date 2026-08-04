/**
 * Rewrite Sudden's template exemplars into a DIFFERENT industry (middle-mile
 * freight) while keeping each template's shape and audience unchanged.
 *
 * Why: the exemplar bodies used to be finished video-delivery messages, so they
 * carried a finished QUESTION about a specific angle. Picking a template
 * therefore picked that template's question, and the model kept shipping synonym
 * swaps of it — MBC Group on 2026-08-04 produced "does your delivery cost per
 * viewer actually come down, or does it track 1:1 with traffic?" against
 * template 2's "does your delivery cost per viewer fall, or does the cost line
 * grow 1:1 with it?". Three separate prose rules telling it not to copy did not
 * hold, because copying was the cheapest path available.
 *
 * A freight exemplar cannot be copied into a message about video. The shape,
 * rhythm, sentence count and beat-welding all still transfer; the content
 * cannot. What the message should actually say now comes from the PROBLEMS WE
 * SOLVE / WHAT IT ACTUALLY DOES menu (policy.drafter.pain_points and
 * value_props), which is the field pair meant to carry it.
 *
 * Only `body` and `anatomy` change. `audience` drives template selection and is
 * untouched. `notes` and `follow_up` are reference-only (never rendered into the
 * prompt) and stay as they are.
 *
 * Numbers inside these exemplars are illustrative and each anatomy says so. The
 * workspace constitution still governs which claims a real message may assert.
 *
 * Usage: tsx scripts/_set_sudden_exemplars.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

const REWRITES: Record<string, { body: string; anatomy: string }> = {
  t1_connectors: {
    body: "Hey Dana, caught your latest Freightlines piece, the $94B cross-dock number got my attention. I'm on the middle-mile cost side of this world, so your data work is required reading. Which slice of that $94B do you think grows fastest over the next 2-3 years?",
    anatomy: "DIFFERENT INDUSTRY ON PURPOSE. Copy the shape, never a word of the content. Trigger: their most recent published piece plus one number from it · Think: which slice of their own number grows fastest (market-level, extends their work rather than challenging it) · Cred: none by design · Talk: none by design, the reply is the win · Shape: 3 sentences, question last, no ask. Numbers here are illustrative.",
  },
  t2_founder: {
    body: "Hey Priya, caught your Manifest talk on doubling lanes in a year. As you add lanes, does cost per load drop, or does it climb with every one you open? For most carriers it climbs. We built a small routing layer that fills the empty return legs, no TMS change. Already got that handled?",
    anatomy: "DIFFERENT INDUSTRY ON PURPOSE. Copy the shape, never a word of the content. Trigger: a thing they said at a named event · Think: a two-option fork about their unit economics, answerable from memory · Cred: one short pattern claim about the category, no source needed because it claims no number · Talk: status-quo exit that lets them decline · Shape: 5 short sentences, pitch is ONE sentence and lands after the question. Numbers here are illustrative.",
  },
  // Disabled today, so it never renders. Rewritten anyway: leaving the original
  // video body here means re-enabling the template silently reintroduces a
  // finished, copyable question about the exact angle everything else was just
  // moved off. A latent landmine is still a landmine.
  t4_discovery: {
    body: "Hey Priya, loved the Manifest bit on standing up a new lane in three weeks. As you pass 500 trucks, what keeps cost per load from rising with every one you add? On most fleets the empty return leg is the biggest single line, and it grows with the network. We run 30-minute sessions with ops teams to size exactly that. Open to one?",
    anatomy: "DIFFERENT INDUSTRY ON PURPOSE, and DISABLED — kept only as a shape reference. Trigger · Think · Cred · Talk, where Talk is a discovery ask. Note the discovery CTA is the weakest of the four ask types in STEP 5; that is why this template is off. Numbers here are illustrative.",
  },
  t3_technical: {
    body: "Hey Marcus, saw you're hiring dispatch engineers, volume must be climbing. How many of your trucks run the return leg empty? Empty running is about a fifth of miles on a typical fleet, and most dispatch teams never see that share broken out on its own. We built a small matching service that pairs return legs between carriers, no TMS or ELD change. Want me to put your numbers to it? Empty-mile share shows up in your own dispatch reports.",
    anatomy: "DIFFERENT INDUSTRY ON PURPOSE. Copy the shape, never a word of the content. Trigger: a job post, bridged to what it implies about their volume · Think: a countable question about waste inside their own operation · Cred: the size of the waste FIRST, then the visibility gap as the jab (they cannot currently see it) · Talk: offer to do the work, with the verification detail riding behind it so they know they can check the answer themselves · Shape: 6 sentences, every one complete, longest of the three templates. Numbers here are illustrative.",
  },
};

async function main() {
  const { data: w, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const policy = (w!.policy ?? {}) as Record<string, unknown>;
  const drafter = (policy.drafter ?? {}) as Record<string, unknown>;
  const templates = (drafter.templates ?? []) as Array<Record<string, unknown>>;
  if (!templates.length) throw new Error('no templates on policy.drafter — run _set_sudden_templates.ts first');

  let changed = 0;
  const next = templates.map((t) => {
    const r = REWRITES[String(t.id)];
    if (!r) return t;
    changed++;
    return { ...t, body: r.body, anatomy: r.anatomy };
  });
  policy.drafter = { ...drafter, templates: next };

  const { error: upErr } = await sb.from('workspaces').update({ policy }).eq('id', WS);
  if (upErr) throw upErr;
  console.log(`rewrote ${changed} exemplar bodies into the freight vertical:`);
  for (const t of next) {
    if (!REWRITES[String(t.id)]) { console.log(`  ${t.id}: unchanged`); continue; }
    console.log(`\n  ${t.id} (${t.enabled === false ? 'disabled' : 'enabled'})`);
    console.log(`    ${String(t.body).slice(0, 150)}…`);
  }
  console.log('\nNo rescore needed: templates are drafter-only, not a scoring input.');
}
main().catch((e) => { console.error(e); process.exit(1); });
