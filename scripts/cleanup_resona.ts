/**
 * Surgical cleanup of test pollution on Resona Labs.
 *
 * Deletes:
 *   - All channel_posts in Resona's channel (every one is from test runs)
 *   - All concurrency_test_* facts (50+ rows from the concurrency benchmark)
 *   - All careers_page_diff signals (every one is from agent_smoke injections)
 *
 * Keeps:
 *   - Resona entity
 *   - Resona channel
 *   - The 4 original seed facts (uses_stack=typescript/postgres/bun, pitch)
 *   - The 1 enricher-extracted "hiring_for" fact
 *
 * Events are append-only and stay (replay_to() can still reconstruct everything).
 *
 * Run with --yes to skip the confirmation prompt.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { createInterface } from 'node:readline';

async function confirm(msg: string): Promise<boolean> {
  if (process.argv.includes('--yes')) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(msg + ' [y/N] ', (a) => {
      rl.close();
      resolve(a.trim().toLowerCase() === 'y');
    });
  });
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await sb.from('workspaces').select('id').like('name','demo · agent-crm%').order('created_at',{ascending:false}).limit(1).single();
  const ent = await sb.from('entities').select('id').eq('workspace_id', ws.data!.id).eq('name', 'Resona Labs').single();
  const chan = await sb.from('channels').select('id').eq('workspace_id', ws.data!.id).eq('account_entity_id', ent.data!.id).single();

  const RESONA = ent.data!.id;
  const CHANNEL = chan.data!.id;

  // Count what we're about to delete
  const posts = await sb.from('channel_posts').select('id', { count: 'exact', head: true }).eq('channel_id', CHANNEL);
  const concurFacts = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('subject_entity', RESONA).eq('predicate', 'concurrency_test');
  const careersSignals = await sb.from('signals').select('id', { count: 'exact', head: true }).eq('entity_id', RESONA).eq('type', 'careers_page_diff');

  console.log(`Resona channel: ${CHANNEL.slice(0,8)}...`);
  console.log('About to delete:');
  console.log(`  ${posts.count ?? 0} channel posts`);
  console.log(`  ${concurFacts.count ?? 0} concurrency-test facts`);
  console.log(`  ${careersSignals.count ?? 0} careers_page_diff signals`);
  console.log('Keeping: entity, channel, 4 seed facts, hiring_for fact, all events.');

  if (!await confirm('Proceed?')) {
    console.log('aborted.');
    return;
  }

  const d1 = await sb.from('channel_posts').delete().eq('channel_id', CHANNEL);
  if (d1.error) console.error('posts delete:', d1.error.message);
  else console.log(`✓ deleted ${posts.count ?? 0} posts`);

  const d2 = await sb.from('facts').delete().eq('subject_entity', RESONA).eq('predicate', 'concurrency_test');
  if (d2.error) console.error('facts delete:', d2.error.message);
  else console.log(`✓ deleted ${concurFacts.count ?? 0} concurrency facts`);

  const d3 = await sb.from('signals').delete().eq('entity_id', RESONA).eq('type', 'careers_page_diff');
  if (d3.error) console.error('signals delete:', d3.error.message);
  else console.log(`✓ deleted ${careersSignals.count ?? 0} careers signals`);

  // Remaining state
  const f = await sb.from('facts').select('predicate, object_text').eq('subject_entity', RESONA);
  const s = await sb.from('signals').select('type').eq('entity_id', RESONA);
  console.log(`\nResona now has:`);
  console.log(`  ${f.data?.length ?? 0} facts:`);
  for (const x of f.data ?? []) console.log(`    ${x.predicate} = ${x.object_text}`);
  console.log(`  ${s.data?.length ?? 0} signals:`);
  for (const x of s.data ?? []) console.log(`    ${x.type}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
