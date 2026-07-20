import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
const SUDDEN = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const sb = createServerClient();
  const since = new Date(Date.now() - 26 * 3600e3).toISOString();
  const { data: picks } = await sb.from('events').select('created_at, payload').eq('workspace_id', SUDDEN).eq('action', 'drafter_shortlist_pick').gte('created_at', since).order('created_at');
  console.log('shortlist picks:');
  for (const e of picks ?? []) console.log(' ', e.created_at.slice(11, 16), JSON.stringify(e.payload)?.slice(0, 220));
  const { data: gates } = await sb.from('gates').select('channel_post_id').eq('workspace_id', SUDDEN).is('decided_at', null);
  const postIds = (gates ?? []).map((g) => g.channel_post_id);
  const { data: posts, error } = await sb.from('channel_posts').select('id, channel_id, body').in('id', postIds);
  if (error) throw error;
  console.log('\npending draft accounts:');
  for (const p of posts ?? []) {
    const { data: ch } = await sb.from('channels').select('account_entity_id').eq('id', p.channel_id).single();
    const { data: ent } = await sb.from('entities').select('id, name').eq('id', ch!.account_entity_id).single();
    const { data: score } = await sb.from('facts').select('object_text').eq('workspace_id', SUDDEN).eq('subject_entity', ent!.id).eq('predicate', 'icp_fit').is('supersedes', null).limit(1);
    console.log(`  ${ent?.name} (icp_fit=${score?.[0]?.object_text ?? '?'}): ${p.body?.slice(0, 90).replace(/\n/g, ' ')}`);
    const { data: sys } = await sb.from('channel_posts').select('kind, body, created_at').eq('channel_id', p.channel_id).eq('kind', 'system').gte('created_at', since);
    for (const s of sys ?? []) console.log(`     [flags] ${s.body?.slice(0, 160).replace(/\n/g, ' ')}`);
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
