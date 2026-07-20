import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPolicy, resolveEnvVar } from '@agent-crm/tools';
async function main() {
  const sb = createServerClient();
  const p = await getPolicy(sb, 'e7052848-2270-41ac-90b6-d9b75c87f6d3');
  console.log('provider:', p.enrichment?.contact_provider, '| fallback:', p.enrichment?.contact_provider_fallback, '| max_pulls:', p.enrichment?.max_contact_pulls_per_run);
  console.log('explorium key:', resolveEnvVar(p, 'EXPLORIUM_API_KEY') ? 'present' : 'MISSING', '| hunter key:', resolveEnvVar(p, 'HUNTER_API_KEY') ? 'present' : 'MISSING');
}
main().catch((e) => { console.error(e); process.exit(1); });
