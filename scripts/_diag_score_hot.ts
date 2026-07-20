import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreEntity } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

async function main() {
  for (const [name, id] of [['Fresha', '1e044f27-69fb-4905-ba10-ec9122002663'], ['Lightspeed', 'd578cabf-2c10-426d-bd0e-d35943bc2563']]) {
    const t0 = Date.now();
    try {
      const s = await scoreEntity(sb, ws, id);
      console.log(`${name}: ${s ? `icp_total=${s.icp_total.toFixed(2)}` : 'NULL'}  (${Date.now() - t0}ms)`);
      if (s) console.log('   breakdown:', JSON.stringify(s.breakdown));
    } catch (e) {
      console.log(`${name}: THREW after ${Date.now() - t0}ms -> ${(e as Error)?.message ?? e}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
