import { config } from 'dotenv';
config({ path: '.env.local' });
import { getCompany } from './readers/twenty.js';
async function main() {
  const r = await getCompany('11x.ai', 'default');
  console.log(`status: ${r.response.status}`);
  const body = r.response.body as any;
  console.log(JSON.stringify(body, null, 2).slice(0, 3000));
}
main().catch((e) => { console.error(e); process.exit(1); });
