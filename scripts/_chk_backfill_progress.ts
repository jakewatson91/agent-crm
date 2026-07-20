import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
async function fetchAll<T>(q: (f: number, t: number) => any): Promise<T[]> {
  const out: T[] = []; let f = 0; const n = 1000;
  for (;;) { const { data } = await q(f, f + n - 1); const r = (data ?? []) as T[]; out.push(...r); if (r.length < n) break; f += n; }
  return out;
}
(async () => {
  const ents = await fetchAll<{ attributes: any }>((f, t) => sb.from('entities').select('attributes').eq('workspace_id', ws).order('id').range(f, t));
  const remaining = ents.filter((e) => e.attributes?._candidate === true).length;
  console.log(`_candidate=true remaining = ${remaining} (started at 472, promoted so far = ${472 - remaining})`);
  // did Fresha/Lightspeed get scored yet?
  for (const [n, id] of [['Fresha', '1e044f27-69fb-4905-ba10-ec9122002663'], ['Lightspeed', 'd578cabf-2c10-426d-bd0e-d35943bc2563']]) {
    const { data } = await sb.from('facts').select('object_text, observed_at').eq('workspace_id', ws).eq('subject_entity', id).eq('predicate', 'icp_fit').is('supersedes', null).maybeSingle();
    console.log(`  ${n}: icp_fit = ${data?.object_text ?? 'still NONE'}${data ? ` (observed ${data.observed_at?.slice(0, 19)})` : ''}`);
  }
})();
