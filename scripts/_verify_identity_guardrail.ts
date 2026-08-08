// Ad-hoc: is the identity guardrail in every channel's prompt?
//
// It used to be a standalone "NEVER LEAD WITH IDENTITY" heading pasted into two
// of the three branches. It now lives once, as a STEP 6 line-edit rule, and
// reaches all three because every channel renders the shared craft block.
// scripts/check_prompt_portability.ts asserts the same thing inside `pnpm check`;
// this stays as the quick one-off read.
import { buildDrafterDecision } from '@agent-crm/tools';

const NEEDLE = 'Who they are is never a hook';

const templated = buildDrafterDecision({
  outreach_channel: 'linkedin',
  templates: [{ id: 't1', label: 'x', audience: 'founders', body: 'hey', enabled: true }],
});
const linkedinGeneric = buildDrafterDecision({ outreach_channel: 'linkedin' });
const email = buildDrafterDecision({ outreach_channel: 'email' });

for (const [name, block] of [['linkedin templated', templated], ['linkedin generic', linkedinGeneric], ['email', email]] as const) {
  console.log(name, '-> guardrail present:', block.includes(NEEDLE));
}
