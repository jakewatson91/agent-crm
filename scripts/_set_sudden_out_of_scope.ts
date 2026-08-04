/**
 * Set Sudden's out-of-scope conditions on policy.drafter.out_of_scope.
 *
 * These are Sudden's product limits, so they are config, not code. Another
 * workspace in another vertical writes its own; the default is an empty list
 * and nothing is vetoed.
 *
 * Both conditions come from evidence already in the workspace:
 *   1. Live. The SOOP account carries "Live is out of scope; the addressable
 *      surface is the VOD/replay catalog on web" as a company_description fact,
 *      and template t3's notes say "web HLS VOD today, native on roadmap". It
 *      was true, written down, and enforced nowhere.
 *   2. Vendors. The ICP is companies "running their own streaming platform".
 *      TVU Networks sells live video infrastructure TO those companies, scored
 *      industry_match 1.00 / icp_fit 0.87, and got drafted a CDN-offload pitch
 *      built on its own customer's viewer numbers.
 *
 * Usage: tsx scripts/_set_sudden_out_of_scope.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

const out_of_scope = [
  "Their video is live only — live sports, live news, live event or live game streaming — with no video-on-demand or replay catalog on the web. We serve web HLS video on demand and replay catalogs today; live streams are out of scope.",
  "They sell video infrastructure, delivery, encoding or production services to streaming companies rather than operating a streaming service of their own. Their customers pay the viewer delivery bill, so there is nothing for us to reduce.",
];

// Dropped before the first rescore: "reaches viewers only through native or TV
// apps, with no web player". Almost every streaming company has a web player, so
// the binary test never fires, and the accounts it was aimed at (vertical drama
// apps, where most viewing really is in-app) have web players too and slip
// through. The real question is what SHARE of viewing is on web, which is a
// sizing question for research to answer, not a condition to veto on.

async function main() {
  const { data: w, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const policy = (w!.policy ?? {}) as Record<string, unknown>;
  const drafter = (policy.drafter ?? {}) as Record<string, unknown>;
  policy.drafter = { ...drafter, out_of_scope };

  // out_of_scope is a SCORING input (it feeds the rubric and scoreInputsHash),
  // so writing it has to bump scoring_config_state.changed_at as well. The
  // scorer's skip-when-stale guard bails before it ever reaches the hash when
  // no fact is newer than the last score, and changed_at is the only thing that
  // gets an unchanged account past it. Without this bump a rescore silently
  // no-ops on most of the book and the new conditions are never applied.
  const changed_at = new Date().toISOString();
  const cfg = (policy.scoring_config_state ?? {}) as Record<string, unknown>;
  policy.scoring_config_state = { ...cfg, changed_at };

  const { error: upErr } = await sb.from('workspaces').update({ policy }).eq('id', WS);
  if (upErr) throw upErr;
  console.log(`set ${out_of_scope.length} out_of_scope conditions on Sudden:`);
  out_of_scope.forEach((c, i) => console.log(`  [${i + 1}] ${c}`));
  console.log(`\nscoring_config_state.changed_at bumped to ${changed_at}`);
  console.log('Run scripts/rescore_all.ts to apply them to existing scores.');
}
main().catch((e) => { console.error(e); process.exit(1); });
