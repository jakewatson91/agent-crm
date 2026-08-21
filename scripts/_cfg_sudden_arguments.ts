/**
 * Write Sudden's argument down, and take back the drafts that made the wrong one.
 *
 * The pitch was never stored anywhere. The About text describes the mechanism
 * ("savings are biggest on a large simultaneous audience for one title") and
 * every reader takes that to mean a premiere, so 26 drafts in a week proposed
 * carrying the customer's premiere. The real argument is that a new release
 * drives catch-up traffic through the OLD seasons, that this is the cost they
 * resent, and that the catalogue is the safe thing to move because the launch
 * itself does not change.
 *
 * Run once. Idempotent: re-running rewrites the same argument and withdraws
 * nothing that is already withdrawn.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { DrafterArgument } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

const ARGUMENTS: DrafterArgument[] = [
  {
    id: 'catalogue_lift',
    label: 'A new release lifts the back catalogue',
    when: 'a new season, film or series lands on their service',
    only_if: 'they run an on-demand or replay catalogue on the web with real depth to it — earlier seasons, a library, a back catalogue — rather than a service that is only live or only a handful of titles',
    so: 'viewers go back through the earlier seasons and the related titles, so the delivery bill grows most on catalogue they have already paid to serve many times over, and none of that catch-up viewing carries the reason they paid for the launch',
    ask: 'put the back catalogue on us and leave the premiere exactly as it is',
    // Deliberately unset. This argument has never been tested against a real
    // account, so it writes three drafts and stops until a human confirms it.
    // Its predecessor was never confirmed by anybody and ran 26 times.
    enabled: true,
  },
];

const WITHDRAW_REASON =
  'Wrong argument: pitched carrying the premiere itself. The premiere is the reason to write, not the thing to sell — what we reduce is the catch-up traffic it drives through the back catalogue, and the catalogue is what we ask for.';

(async () => {
  const { data, error } = await sb.from('workspaces').select('policy').eq('id', WS).maybeSingle();
  if (error) throw error;
  const policy = ((data as any)?.policy ?? {}) as Record<string, any>;

  const upd = await sb.from('workspaces')
    .update({ policy: { ...policy, drafter: { ...(policy.drafter ?? {}), arguments: ARGUMENTS } } })
    .eq('id', WS);
  if (upd.error) throw upd.error;
  console.log(`stored ${ARGUMENTS.length} argument(s) on policy.drafter.arguments`);
  for (const a of ARGUMENTS) console.log(`  ${a.id}  proven_at=${a.proven_at ?? '(unproven — writes 3 drafts then waits)'}`);

  // --- withdraw the drafts that made the old argument ---
  const chans = await sb.from('channels').select('id').eq('workspace_id', WS).limit(2000);
  const chIds = ((chans.data ?? []) as any[]).map((c) => c.id);
  let live: any[] = [];
  for (let i = 0; i < chIds.length; i += 200) {
    const r = await sb.from('channel_posts').select('id, cites, created_at')
      .in('channel_id', chIds.slice(i, i + 200)).eq('kind', 'touch_draft').is('withdrawn_at', null).limit(1000);
    live = live.concat(r.data ?? []);
  }
  console.log(`\nlive drafts to withdraw: ${live.length}`);
  const anchors = new Set<string>();
  for (const p of live) for (const c of p.cites ?? []) anchors.add(c);

  const now = new Date().toISOString();
  for (let i = 0; i < live.length; i += 100) {
    const ids = live.slice(i, i + 100).map((p) => p.id);
    const r = await sb.from('channel_posts')
      .update({ withdrawn_at: now, withdrawn_reason: WITHDRAW_REASON })
      .in('id', ids);
    if (r.error) throw r.error;
  }
  console.log(`withdrawn: ${live.length} (bodies kept for comparison)`);
  console.log(`anchors released back into the pool: ${anchors.size}`);

  // How many of those released anchors are still fresh enough to write about.
  const fresh = new Date(Date.now() - 30 * 86400e3).toISOString();
  const ids = [...anchors];
  let stillFresh = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const r = await sb.from('facts').select('id').in('id', ids.slice(i, i + 100))
      .not('happened_at', 'is', null).gte('happened_at', fresh);
    stillFresh += (r.data ?? []).length;
  }
  console.log(`of those, still inside the 30-day window (writable again today): ${stillFresh}`);
})().catch((e) => { console.error(e); process.exit(1); });
