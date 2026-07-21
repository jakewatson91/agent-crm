import { buildDrafterDecision } from '@agent-crm/tools';

const templated = buildDrafterDecision({
  outreach_channel: 'linkedin',
  templates: [{ id: 't1', label: 'x', audience: 'founders', body: 'hey', enabled: true }],
});
const linkedinGeneric = buildDrafterDecision({ outreach_channel: 'linkedin' });
const email = buildDrafterDecision({ outreach_channel: 'email' });

for (const [name, block] of [['linkedin templated', templated], ['linkedin generic', linkedinGeneric], ['email', email]] as const) {
  console.log(name, '-> guardrail present:', block.includes('NEVER LEAD WITH IDENTITY'));
}
