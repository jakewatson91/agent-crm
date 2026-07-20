import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';

const SUDDEN = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createServerClient();
  const since = new Date(Date.now() - 26 * 3600e3).toISOString();

  const { data: chans, error: chErr } = await sb.from('channels').select('id, account_entity_id').eq('workspace_id', SUDDEN);
  if (chErr) throw chErr;
  const chIds = (chans ?? []).map((c) => c.id);
  console.log(`channels: ${chIds.length}`);

  const kinds = new Map<string, number>();
  const draftRows: any[] = [];
  for (let i = 0; i < chIds.length; i += 100) {
    const { data: posts, error } = await sb.from('channel_posts').select('id, kind, created_at, body, channel_id').in('channel_id', chIds.slice(i, i + 100)).gte('created_at', since);
    if (error) throw error;
    for (const p of posts ?? []) {
      kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1);
      if (/draft|outreach|message/i.test(p.kind)) draftRows.push(p);
    }
  }
  console.log('post kinds last 26h:');
  for (const [k, v] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);

  const entName = new Map((chans ?? []).map((c) => [c.id, c.account_entity_id]));
  for (const p of draftRows.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const { data: ent } = await sb.from('entities').select('name').eq('id', entName.get(p.channel_id)!).single();
    console.log(`  ${p.created_at.slice(0, 16)} [${p.kind}] ${ent?.name}: ${p.body?.slice(0, 140).replace(/\n/g, ' ')}`);
  }

  const { data: gates, error: gErr } = await sb.from('gates').select('*').eq('workspace_id', SUDDEN).gte('created_at', since).order('created_at', { ascending: true });
  if (gErr) console.log('gates error:', gErr.message);
  console.log(`\ngates created last 26h: ${gates?.length ?? 0}`);
  for (const g of gates ?? []) console.log(`  ${g.created_at.slice(0, 16)}  decided=${g.decided_at?.slice(0, 16) ?? 'PENDING'}  ${JSON.stringify(g).slice(0, 200)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
