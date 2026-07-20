// Offline #3 check: the persisted Sudden strategy's social angle builds an Exa
// request with include_domains from policy.research.social_domains.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPolicy, resolveStrategy } from '@agent-crm/tools';
import { buildAngleRequest } from '../inngest/functions/research.ts';

async function main() {
  const sb = createServerClient();
  const policy = await getPolicy(sb, 'e7052848-2270-41ac-90b6-d9b75c87f6d3');
  const socialDomains = (policy.research?.social_domains ?? []).filter(Boolean);
  for (const angle of resolveStrategy(policy)) {
    const built = buildAngleRequest(angle, 'Al Kass', 'alkass.net', '', socialDomains);
    console.log(angle.id, `[${angle.domain_scope}]`, built ? JSON.stringify(built.params) : 'NULL');
  }
  // And with social unconfigured: the angle must be skipped, not mis-built.
  const social = resolveStrategy(policy).find((a) => a.domain_scope === 'social')!;
  console.log('social w/o domains →', buildAngleRequest(social, 'Al Kass', '', '', []) === null ? 'null (correct)' : 'BUILT (WRONG)');
}
main().catch((e) => { console.error(e); process.exit(1); });
