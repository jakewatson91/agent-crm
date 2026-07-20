import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const since24 = new Date(Date.now() - 86_400_000).toISOString();

async function fetchAll<T>(q: (f: number, t: number) => any): Promise<T[]> {
  const out: T[] = []; let f = 0; const size = 1000;
  for (;;) { const { data, error } = await q(f, f + size - 1); if (error) throw error; const rows = (data ?? []) as T[]; out.push(...rows); if (rows.length < size) break; f += size; }
  return out;
}

async function main() {
  for (const id of ['1e044f27-69fb-4905-ba10-ec9122002663', 'd578cabf-2c10-426d-bd0e-d35943bc2563']) {
    const { data: ent } = await sb.from('entities').select('id, name, attributes').eq('workspace_id', ws).eq('id', id).limit(1);
    const e = ent?.[0];
    const fullId = e?.id;
    console.log(`\n=== ${id}  name="${e?.name}"  ===`);
    if (!fullId) { console.log('  (entity not found)'); continue; }
    const sigs = await fetchAll<{ type: string; structured_tags: any; body_hash: string | null }>((f, t) => sb.from('signals')
      .select('type, structured_tags, body_hash').eq('workspace_id', ws).eq('entity_id', fullId)
      .gte('created_at', since24).order('created_at', { ascending: false }).range(f, t));
    console.log(`  signals_24h = ${sigs.length}  (distinct body_hash = ${new Set(sigs.map((s) => s.body_hash)).size})`);
    const bySrc = new Map<string, number>(); const byType = new Map<string, number>();
    for (const s of sigs) {
      const src = s.structured_tags?.signal_source ?? s.structured_tags?.source_id ?? '(unknown)';
      bySrc.set(src, (bySrc.get(src) ?? 0) + 1);
      byType.set(s.type, (byType.get(s.type) ?? 0) + 1);
    }
    console.log('  by source:', JSON.stringify(Object.fromEntries(bySrc)));
    console.log('  by type:', JSON.stringify(Object.fromEntries(byType)));
    // current icp_fit
    const { data: icp } = await sb.from('facts').select('object_text, created_at, observed_at').eq('workspace_id', ws).eq('subject_entity', fullId).eq('predicate', 'icp_fit').is('supersedes', null).limit(1);
    console.log(`  current icp_fit = ${icp?.[0]?.object_text ?? 'NONE'}  created=${icp?.[0]?.created_at?.slice(0, 19) ?? '-'}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
