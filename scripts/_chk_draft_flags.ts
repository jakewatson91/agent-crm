// #5 verify: draftAuditFlags against Sudden's real drafter config.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPolicy } from '@agent-crm/tools';
import { draftAuditFlags } from '../inngest/functions/agent_logic.ts';

async function main() {
  const sb = createServerClient();
  const p = await getPolicy(sb, 'e7052848-2270-41ac-90b6-d9b75c87f6d3');
  const templates = p.drafter?.templates ?? [];
  console.log('channel:', p.drafter?.outreach_channel, '| char_budget:', p.drafter?.char_budget, '| templates:', templates.map((t: any) => t.label));
  const common = { outreach_channel: (p.drafter?.outreach_channel ?? 'email') as 'email' | 'linkedin', char_budget: p.drafter?.char_budget, templates };

  const bad = draftAuditFlags({
    ...common,
    body: 'x'.repeat(520) + ' see https://example.com/case-study for details',
    reasoning: 'I wrote a message about their CDN costs.',
  });
  console.log('\nbad draft flags:', JSON.stringify(bad, null, 1));

  const label = (templates[0] as any)?.label ?? 'template 1';
  const good = draftAuditFlags({
    ...common,
    body: 'Saw your talk on scaling live sports streams. Most broadcasters we work with cut CDN spend 60-80% without touching their player. Worth a look?',
    reasoning: `Chose the "${label}" template because the recipient runs streaming infrastructure; anchored to the conference talk fact.`,
  });
  console.log('good draft flags:', JSON.stringify(good));
}
main().catch((e) => { console.error(e); process.exit(1); });
