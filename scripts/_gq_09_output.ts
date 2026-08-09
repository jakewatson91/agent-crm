/**
 * Step 9: the output end. How many drafts were produced vs gated for lack of a
 * hook, and which facts the drafts actually cited — the ground truth for "which
 * facts are worth extracting".
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const DAYS = Number(process.argv[2] ?? 30);

(async () => {
  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
  const chans = (await sb.from('channels').select('id, account_entity_id').eq('workspace_id', WS).limit(5000)).data ?? [];
  const chanIds = chans.map((c: any) => c.id);
  let posts: any[] = [];
  for (let i = 0; i < chanIds.length; i += 200) {
    const r = await sb.from('channel_posts').select('id, kind, body, cites, created_at, channel_id')
      .in('channel_id', chanIds.slice(i, i + 200)).gte('created_at', since).limit(2000);
    posts = posts.concat(r.data ?? []);
  }
  const byKind = new Map<string, number>();
  for (const p of posts as any[]) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
  console.log(`channel_posts last ${DAYS}d: ${posts.length}`);
  for (const [k, v] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);

  const gates = (await sb.from('gates').select('id, policy, decision, requested_at').eq('workspace_id', WS).gte('requested_at', since).limit(2000)).data ?? [];
  const byPolicy = new Map<string, number>();
  for (const g of gates as any[]) byPolicy.set(`${g.policy} / ${g.decision ?? 'pending'}`, (byPolicy.get(`${g.policy} / ${g.decision ?? 'pending'}`) ?? 0) + 1);
  console.log(`\ngates last ${DAYS}d: ${gates.length}`);
  for (const [k, v] of [...byPolicy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(v).padStart(5)}  ${k}`);

  // Which facts did drafts actually cite?
  const cited = new Set<string>();
  for (const p of posts as any[]) for (const c of p.cites ?? []) cited.add(c);
  console.log(`\ndistinct fact ids cited by posts: ${cited.size}`);
  const ids = [...cited];
  const preds = new Map<string, number>();
  const samples: string[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const r = await sb.from('facts').select('predicate, object_text').in('id', ids.slice(i, i + 300));
    for (const f of r.data ?? []) {
      preds.set(f.predicate, (preds.get(f.predicate) ?? 0) + 1);
      if (samples.length < 30) samples.push(`${f.predicate} = ${String(f.object_text ?? '').slice(0, 90)}`);
    }
  }
  const resolved = [...preds.values()].reduce((a, b) => a + b, 0);
  console.log(`  of those, still resolvable in facts: ${resolved} (${cited.size - resolved} dangling)`);
  console.log('\n=== predicates the drafter actually cited ===');
  for (const [k, v] of [...preds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${String(v).padStart(4)}  ${k}`);
  console.log('\n=== sample cited facts ===');
  for (const s of samples) console.log(`  · ${s}`);
})();
