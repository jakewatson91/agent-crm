import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const SRC = '369ae42b-63cc-4df4-b2d3-04f810a18ef9';
async function main() {
  const { error } = await sb.from('sources').update({ active: true }).eq('id', SRC);
  if (error) throw new Error(error.message);
  console.log('ATS source re-activated');
  const key = process.env.INNGEST_EVENT_KEY!;
  const res = await fetch(`https://inn.gs/e/${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'source.run', data: { source_id: SRC, workspace_id: 'e7052848-2270-41ac-90b6-d9b75c87f6d3' } }),
  });
  console.log('source.run sent:', res.status);
}
main().catch((e) => { console.error(e); process.exit(1); });
