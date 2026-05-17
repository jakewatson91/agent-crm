/**
 * Audit data available for the realistic-drafter benchmark:
 *   - contacts per account (agent-crm side)
 *   - past channel_posts (drafts/sent) per account
 *   - signals per account
 *
 * Goal: figure out whether we need to seed contacts and past drafts before
 * running the multi-step drafter benchmark.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const ACCOUNTS = ['Resona Labs', 'Forge Robotics', 'Plaintext.so', 'Halo Health', 'Brightvine', 'Strand Compute'];

async function main() {
  const ws = await supabase
    .from('workspaces')
    .select('id')
    .like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (ws.error) throw ws.error;
  const wsId = ws.data!.id as string;

  console.log(`workspace: ${wsId}\n`);
  console.log(`${'account'.padEnd(20)} ${'contacts'.padStart(10)} ${'sigs'.padStart(6)} ${'past_posts'.padStart(12)}`);

  for (const name of ACCOUNTS) {
    const ent = await supabase
      .from('entities').select('id').eq('workspace_id', wsId).eq('kind', 'account').eq('name', name).single();
    if (ent.error) { console.log(`${name.padEnd(20)} (not found)`); continue; }

    const contacts = await supabase
      .from('contacts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', wsId).eq('account_entity', ent.data!.id);
    const sigs = await supabase
      .from('signals').select('id', { count: 'exact', head: true })
      .eq('workspace_id', wsId).eq('entity_id', ent.data!.id);
    const posts = await supabase
      .from('channel_posts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', wsId).eq('entity_id', ent.data!.id);

    console.log(`${name.padEnd(20)} ${String(contacts.count ?? 0).padStart(10)} ${String(sigs.count ?? 0).padStart(6)} ${String(posts.count ?? 0).padStart(12)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
