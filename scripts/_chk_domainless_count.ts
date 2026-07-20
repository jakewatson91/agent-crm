import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { entityIdsOfType } from '@agent-crm/tools';

const SUDDEN = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createServerClient();
  const acctIds = await entityIdsOfType(sb, SUDDEN, 'account');
  let archived = 0, candidate = 0, hasDomain = 0, noDomain = 0;
  const samples: Array<{ id: string; name: string }> = [];
  for (let i = 0; i < acctIds.length; i += 200) {
    const { data, error } = await sb.from('entities')
      .select('id, name, attributes, archived_at')
      .in('id', acctIds.slice(i, i + 200));
    if (error) throw error;
    for (const e of (data ?? []) as any[]) {
      if (e.archived_at) { archived++; continue; }
      if (e.attributes?._candidate === true) { candidate++; continue; }
      if (typeof e.attributes?.domain === 'string' && e.attributes.domain.length > 0) { hasDomain++; continue; }
      noDomain++;
      if (samples.length < 5) samples.push({ id: e.id.slice(0, 8), name: e.name });
    }
  }
  console.log({ accounts: acctIds.length, archived, candidate, hasDomain, noDomain });
  console.log('samples:', samples);
}
main().catch((e) => { console.error(e); process.exit(1); });
