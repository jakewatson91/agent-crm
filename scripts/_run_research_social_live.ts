// Live #3 verify: full research run on one hot Sudden account; report per-angle
// searches and what the disambiguation gate did.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { runEntityResearch } from '../inngest/functions/research.ts';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createServerClient();
  // Hot = current icp_fit >= 0.7 with a domain.
  const { data: facts } = await sb.from('facts')
    .select('subject_entity, object_text, observed_at')
    .eq('workspace_id', WS).eq('predicate', 'icp_fit')
    .gte('observed_at', new Date(Date.now() - 14 * 86400_000).toISOString())
    .order('observed_at', { ascending: false }).limit(300);
  const seen = new Set<string>();
  for (const f of (facts ?? []) as any[]) {
    if (seen.has(f.subject_entity)) continue;
    seen.add(f.subject_entity);
    if (Number(f.object_text) < 0.7) continue;
    const { data: e } = await sb.from('entities').select('id, name, attributes').eq('id', f.subject_entity).single();
    const domain = (e as any)?.attributes?.domain;
    if (!domain) continue;
    console.log('target:', (e as any).name, domain, 'score', f.object_text);
    const r = await runEntityResearch(sb, {
      workspace_id: WS, entity_id: (e as any).id, entity_name: (e as any).name,
      reason: 'live verify: social scope post-topup',
    });
    console.log('run result:', JSON.stringify(r));
    return;
  }
  console.log('no hot account with domain found');
}
main().catch((e) => { console.error(e); process.exit(1); });
