import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { chatComplete } from '@agent-crm/primitives';

const ENTITY_ATTRS = {
  domain: 'approxima.ai',
  website: 'https://approxima.ai',
  industry: 'B2B',
  one_liner: 'Your software should build itself.',
  description: 'Human-assisted development should be for novel ideation, not routine maintenance, bug fixes or incremental updates. Approxima is bringing you that future with agents that can scope work, code, validate their fixes end-to-end in sandbox environments and merge to production.',
  team_size: 2,
  yc_batch: 'Winter 2026',
};

const SYSTEM_PREAMBLE = `You operate inside an agent-native CRM. DATA MODEL — accounts and contacts are "entities." Each entity has attributes and FACTS asserted against it. CITATION DISCIPLINE — only extract what's grounded in the signal. DUPLICATION — don't re-extract what's already known.`;

const BASE_DECISION = `A new signal arrived about the account in the user message. Extract atomic factual claims about THIS entity that are supported by the signal AND that the system doesn't already know.

DO NOT extract:
- Anything already present in the entity's ATTRIBUTES.
- Anything already present in the ACTIVE FACTS list.
- Generic descriptors obvious from the entity name or category.

Each claim should be ATOMIC and VERBATIM-GROUNDED. Use object_text for the value. Confidence: 0.95 explicit, 0.7 implied. Skip lower.

Output strictly valid JSON: {"action":"enrich","facts":[{"predicate":"...","object_text":"...","confidence":0.0}],"summary":"...","reasoning":"..."}`;

const COLLISION_CHECK_LINE = `\n\nIDENTITY CHECK (do this first) — companies can share a name. Before extracting anything, compare the signal's content and source URL against this account's known attributes (domain, one_liner, description, industry). If the signal is clearly describing a different organization that happens to share this name (different domain, different industry, different product), output {"action":"enrich","facts":[],"summary":"skipped: signal appears to describe a different company with the same name","reasoning":"<what mismatched>"} and extract nothing.`;

async function runCase(label: string, decisionBlock: string, signalBody: string, signalUrl: string) {
  const userPrompt = `ACCOUNT: Approxima
ATTRIBUTES (already known):
${JSON.stringify(ENTITY_ATTRS, null, 2)}

ACTIVE FACTS (already asserted):
  (none yet)

SIGNAL:
${JSON.stringify({ type: 'research_result', structured_tags: { signal_source: 'research', url: signalUrl }, body_for_embedding: signalBody }, null, 2)}

Decide.`;

  const result = await chatComplete({
    model: 'deepseek-v4-flash',
    api_keys: { deepseek: process.env.DEEPSEEK_API_KEY },
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${SYSTEM_PREAMBLE}\n\nYou are a fact extractor for an agent-native CRM.\n\n${decisionBlock}` },
      { role: 'user', content: userPrompt },
    ],
  } as any);
  console.log(`\n=== ${label} ===`);
  console.log(result.text ?? JSON.stringify(result).slice(0, 800));
}

async function main() {
  const badBody = `Approxima\nHome - Approxima\n\n## Approxima\n\n# is developing a novel treatment for patients with tricuspid valve regurgitation\n\n### Tricuspid regurgitation\n\n>13M\n\nPatients worldwide\n\nwith at least moderate TR\n\n50%\n\n2-years mortality rate\n\nTR ≥ severe\n\n99%\n\nPatients remain untreated`;
  const badUrl = 'https://www.approximamedical.com/';

  await runCase('BEFORE (no identity check) — wrong-company signal', BASE_DECISION, badBody, badUrl);
  await runCase('AFTER (with identity check) — wrong-company signal', BASE_DECISION + COLLISION_CHECK_LINE, badBody, badUrl);

  // Sanity: a genuinely correct signal should still extract with the new instruction.
  const goodBody = `Approxima · YC W26 · YC Watcher\n\n## About\n\nHuman-assisted development should be for novel ideation, not routine maintenance, bug fixes or incremental updates. Approxima is bringing you that future with agents that can scope work, code, validate their fixes end-to-end in sandbox environments and merge to production. The team just closed a $3.2M seed round led by a notable AI-focused fund.`;
  const goodUrl = 'https://ycwatcher.info/en/companies/approxima';
  await runCase('AFTER (with identity check) — real signal, third-party domain', BASE_DECISION + COLLISION_CHECK_LINE, goodBody, goodUrl);
}
main().catch((e) => { console.error(e); process.exit(1); });
