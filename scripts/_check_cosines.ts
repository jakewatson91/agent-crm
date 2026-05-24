import { createServerClient } from '@agent-crm/db';

const WS_ID = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const SUB = 'd8a3abd2-8f6d-4dc2-8697-cb720de9d542';

async function main() {
  const sb = createServerClient();
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const r = await sb.from('signals').select('id, entity_id, structured_tags')
    .eq('workspace_id', WS_ID).eq('type', 'hiring_post').gte('observed_at', since);
  console.log('hiring signals last 1h:', r.data?.length);

  await sb.from('subscriptions').update({ threshold: 0 }).eq('id', SUB);
  const rows: Array<{ entity: string; title: string; sim: number }> = [];
  for (const s of r.data ?? []) {
    const ent = await sb.from('entities').select('name').eq('id', s.entity_id).maybeSingle();
    const m = await sb.rpc('match_signal_to_subscriptions', { p_signal_id: s.id });
    const ourMatch = (m.data ?? []).find((row: any) => row.subscription_id === SUB);
    const sim = ourMatch ? Number(ourMatch.similarity) : NaN;
    rows.push({ entity: ent.data?.name ?? '?', title: (s.structured_tags as any)?.job_title ?? '?', sim });
  }
  await sb.from('subscriptions').update({ threshold: 0.5 }).eq('id', SUB);
  rows.sort((a, b) => (b.sim || 0) - (a.sim || 0));

  console.log('\nTOP 30 NON-SILA by cosine:');
  for (const r of rows.filter((x) => x.entity !== 'Sila').slice(0, 30)) console.log('  ', r.sim.toFixed(3), r.entity.padEnd(20), r.title);
  console.log('\nNon-Sila distribution:');
  const nonSila = rows.filter((x) => x.entity !== 'Sila');
  console.log(' total:', nonSila.length);

  const buckets: Record<string, number> = { '>=0.6': 0, '0.5-0.6': 0, '0.4-0.5': 0, '0.3-0.4': 0, '<0.3': 0 };
  for (const r of rows) {
    if (r.sim >= 0.6) buckets['>=0.6']++;
    else if (r.sim >= 0.5) buckets['0.5-0.6']++;
    else if (r.sim >= 0.4) buckets['0.4-0.5']++;
    else if (r.sim >= 0.3) buckets['0.3-0.4']++;
    else buckets['<0.3']++;
  }
  console.log('\nDistribution:', buckets);
  console.log('total signals:', rows.length);
}
main().catch((e) => { console.error(e); process.exit(1); });
