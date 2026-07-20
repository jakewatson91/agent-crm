import { createServerClient } from '@agent-crm/db';
import { entityIdsOfType } from '@agent-crm/tools';
import { runEntityResearch } from '../inngest/functions/research.ts';

const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const nums = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const N = nums[0] ?? 3;
const START = nums[1] ?? 0;

async function main() {
  const supabase = createServerClient();
  const acctIds = await entityIdsOfType(supabase, WS, 'account');
  // Keep the .in() list small — past a few hundred ids PostgREST silently returns 0 rows.
  const ents = await supabase.from('entities').select('id, name, attributes').in('id', acctIds.slice(0, 150));
  const withDomain = ((ents.data ?? []) as Array<{ id: string; name: string; attributes: { domain?: string } | null }>)
    .filter((e) => { const d = e.attributes?.domain ?? ''; return d && !d.endsWith('.example'); });
  const targets = withDomain.slice(START, START + N);

  console.log(`Running REAL research (writes signals) on ${targets.length} entities...\n`);
  for (const t of targets) {
    const r = await runEntityResearch(supabase, { workspace_id: WS, entity_id: t.id, entity_name: t.name, reason: 'manual-proof' });
    console.log(`• ${t.name} (${t.attributes?.domain})`);
    console.log(`    ${JSON.stringify(r)}`);
  }

  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const sig = await supabase.from('signals')
    .select('entity_id, structured_tags, observed_at, body_for_embedding')
    .eq('workspace_id', WS).eq('type', 'research_result')
    .gte('observed_at', since)
    .order('observed_at', { ascending: false });
  // Isolate MY run from the old dispatcher running concurrently on Render.
  const rows = ((sig.data ?? []) as Array<{ structured_tags: any; body_for_embedding: string | null }>)
    .filter((r) => r.structured_tags?.triggered_by === 'manual-proof');
  const byAngle: Record<string, number> = {};
  for (const s of rows) { const a = s.structured_tags?.research_angle ?? '?'; byAngle[a] = (byAngle[a] ?? 0) + 1; }

  console.log(`\n=== ${rows.length} new research_result signals in last 10 min ===`);
  console.log('by angle:', JSON.stringify(byAngle), '\n');
  for (const s of rows.slice(0, 30)) {
    const t = s.structured_tags ?? {};
    console.log(`- [${t.research_angle}] ${(s.body_for_embedding || '').split('\n')[0].slice(0, 78)}`);
    console.log(`    ${t.url}  ${t.published_at ?? ''}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
