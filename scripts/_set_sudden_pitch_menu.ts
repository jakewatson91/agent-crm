/**
 * Rewrite Sudden's PROBLEMS WE SOLVE / WHAT IT ACTUALLY DOES menu around what
 * the product actually does: offload needs viewers watching the same title at
 * the same time, and the target is back catalogue, not live.
 *
 * Why the old menu produced one message over and over:
 *
 * - `pain_points[0]` was "Delivery cost per viewer never falls; the cost line
 *   grows one to one with the audience". That is not a problem the buyer has,
 *   it is the constitution's credibility claim. Leaving it on the menu handed
 *   the model the answer, which it asked straight back as the question. It is
 *   still an allowed claim; it is just not something to pick.
 * - The other three were the same problem at three zoom levels, so nothing
 *   distinguished them and the general one won every time.
 * - `value_props` had exactly ONE entry describing a thing the product does for
 *   the buyer; the other three are objection handlers (cheap to install,
 *   verifiable, safe fallback). "Pick the value prop that answers your problem"
 *   had one pickable answer, so every pitch sentence was a paraphrase of it.
 * - Nothing on the menu answered `pain_points[2]` (an understaffed delivery
 *   team) at all, so a draft that picked it had nothing to offer.
 *
 * Deliberately NOT here, and do not re-add without the mechanism changing:
 * anything about a premiere, a live match or a launch peak. `out_of_scope`
 * condition 1 vetoes live-only accounts, so a pain point about live events
 * points the drafter at the accounts the veto exists to exclude. Binge viewing
 * and long-tail library rewatch are out for a different reason: both are
 * viewing spread over time, and spread-out viewing forms no swarm.
 *
 * Cost: none. pain_points and value_props are NOT in `scoreInputsHash`, so this
 * triggers no rescore. It does change the pitch vector that ranks facts
 * (`score_facts.ts` embeds these two lists), which is one embedding call.
 *
 * CAUTION: these fields are re-derived from the workspace About text by
 * `deriveDefaults`, so saving About in Settings will overwrite everything this
 * script writes. If these stick, fold them back into About too.
 *
 * Usage: tsx scripts/_set_sudden_pitch_menu.ts [--apply]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const APPLY = process.argv.includes('--apply');

// Three problems, each recognisable from facts the book actually holds, and
// none of them a restatement of the 1:1 claim.
const PAIN_POINTS = [
  'Popular titles are watched by a lot of people at the same time, and every one of those views ships the same bytes again',
  'On ad-funded catalogue, delivery comes out of a fixed yield per view, so more views can mean less margin',
  'Traffic grows faster than the delivery team, so the cost line has no owner',
];

// Entry 1 rewritten to say what it removes and to carry the simultaneity the
// mechanism depends on. Entries 2-4 are unchanged. Entry 5 is new: it is what
// answers the third problem above, which previously had no answer.
const VALUE_PROPS = [
  'Removes the repeat share: the same segments from the same popular titles, shipped again to viewer after viewer watching at the same time',
  'Drops in as a script plus a service worker, with no change to CDN, player, origin or encoding',
  "Offload percentage shows up in the customer's own CDN dashboard, so they can verify it themselves",
  "Falls back to the CDN automatically when a direct connection can't be made",
  'Runs without anyone on the video team owning it day to day',
];

async function main() {
  const { data: w, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const policy = (w!.policy ?? {}) as Record<string, unknown>;
  const drafter = (policy.drafter ?? {}) as Record<string, unknown>;

  const show = (label: string, before: unknown, after: string[]) => {
    console.log(`\n=== ${label} ===`);
    console.log('BEFORE:');
    for (const s of (before as string[] ?? [])) console.log(`  - ${s}`);
    console.log('AFTER:');
    for (const s of after) console.log(`  - ${s}`);
  };
  show('pain_points (PROBLEMS WE SOLVE)', drafter.pain_points, PAIN_POINTS);
  show('value_props (WHAT IT ACTUALLY DOES)', drafter.value_props, VALUE_PROPS);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }
  policy.drafter = { ...drafter, pain_points: PAIN_POINTS, value_props: VALUE_PROPS };
  const { error: upErr } = await sb.from('workspaces').update({ policy }).eq('id', WS);
  if (upErr) throw upErr;
  console.log('\nWritten. No rescore needed — neither field is in scoreInputsHash.');
}
main().catch((e) => { console.error(e); process.exit(1); });
