import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';

const SUDDEN = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createServerClient();
  const since = new Date(Date.now() - 26 * 3600e3).toISOString();

  // channel_posts kinds in window
  const { data: posts } = await sb.from('channel_posts').select('kind, created_at, body, channel_id').eq('workspace_id', SUDDEN).gte('created_at', since).order('created_at', { ascending: true });
  const kinds = new Map<string, number>();
  for (const p of posts ?? []) kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1);
  console.log(`channel_posts last 26h: ${posts?.length ?? 0}`);
  for (const [k, v] of kinds) console.log(`  ${k.padEnd(20)} ${v}`);

  // the drafts themselves (whatever kind) — show any post whose kind mentions draft/outreach/message
  for (const p of (posts ?? []).filter((p) => /draft|outreach|message/i.test(p.kind))) {
    const { data: ch } = await sb.from('channels').select('account_entity_id').eq('id', p.channel_id).single();
    const { data: ent } = await sb.from('entities').select('name').eq('id', ch!.account_entity_id).single();
    console.log(`  ${p.created_at.slice(0, 16)} [${p.kind}] ${ent?.name}: ${p.body?.slice(0, 120).replace(/\n/g, ' ')}`);
  }

  // gates in window regardless of decision state
  const { data: gates } = await sb.from('gates').select('id, created_at, decided_at, decision, channel_post_id').eq('workspace_id', SUDDEN).gte('created_at', since).order('created_at', { ascending: true });
  console.log(`\ngates created last 26h: ${gates?.length ?? 0}`);
  for (const g of gates ?? []) console.log(`  ${g.created_at.slice(0, 16)}  decided=${g.decided_at?.slice(0, 16) ?? 'PENDING'}  decision=${(g as any).decision ?? ''}`);

  // enrichment_skipped reasons
  const { data: skips } = await sb.from('events').select('payload').eq('workspace_id', SUDDEN).eq('action', 'enrichment_skipped').gte('created_at', since).limit(1000);
  const reasons = new Map<string, number>();
  for (const e of skips ?? []) {
    const r = String((e.payload as any)?.reason ?? JSON.stringify(e.payload)?.slice(0, 60));
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }
  console.log(`\nenrichment_skipped reasons (${skips?.length ?? 0}):`);
  for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${k.slice(0, 90).padEnd(90)} ${v}`);

  // signal tag shape sample
  const { data: sig } = await sb.from('signals').select('structured_tags').eq('workspace_id', SUDDEN).gte('created_at', since).limit(3);
  console.log('\nsignal structured_tags samples:');
  for (const s of sig ?? []) console.log(' ', JSON.stringify(s.structured_tags)?.slice(0, 250));

  // domain_resolved timestamps
  const { data: dr } = await sb.from('events').select('created_at, payload').eq('workspace_id', SUDDEN).eq('action', 'domain_resolved').gte('created_at', since).order('created_at', { ascending: true });
  console.log(`\ndomain_resolved (${dr?.length ?? 0}):`);
  for (const e of dr ?? []) console.log(`  ${e.created_at.slice(0, 16)}  ${JSON.stringify(e.payload)?.slice(0, 120)}`);

  // research_triggered timeline (hourly)
  const { data: rt } = await sb.from('events').select('created_at').eq('workspace_id', SUDDEN).eq('action', 'research_triggered').gte('created_at', since).order('created_at', { ascending: true });
  const hours = new Map<string, number>();
  for (const e of rt ?? []) { const h = e.created_at.slice(0, 13); hours.set(h, (hours.get(h) ?? 0) + 1); }
  console.log('\nresearch_triggered by hour:');
  for (const [k, v] of hours) console.log(`  ${k}  ${'#'.repeat(v)} ${v}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
