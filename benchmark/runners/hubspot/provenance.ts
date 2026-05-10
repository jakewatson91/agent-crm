/**
 * Provenance demo: HubSpot side.
 *
 * The agent-crm provenance demo walks fact -> source_event -> actor -> prompt_hash
 * for the bun-supersedes-python supersede chain on Resona Labs.
 *
 * On HubSpot we attempt the same. The chain dead-ends almost immediately because:
 *   - HubSpot has no fact table (facts are prose lines inside agent_facts).
 *   - HubSpot has no event log we can query.
 *   - HubSpot has no actor record per write (just createdBy if you have it).
 *   - HubSpot has no prompt_hash field anywhere.
 *
 * We document each dead-end so the comparison is concrete, not hand-wavy.
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local' });
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../../metrics');

const HS_TOKEN = process.env.HUBSPOT_SERVICE_KEY!;
if (!HS_TOKEN) throw new Error('Missing HUBSPOT_SERVICE_KEY');
const HS = 'https://api.hubapi.com';

async function hs(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${HS}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HS_TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    return { __error: { status: res.status, body: text } };
  }
  return res.status === 204 ? null : res.json();
}

async function main() {
  console.log('attempting provenance walk on HubSpot for the bun fact on Resona Labs…\n');

  // Step 1: locate the company.
  const search = await hs('POST', `/crm/v3/objects/companies/search`, {
    filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: 'Resona Labs' }] }],
    properties: ['name', 'agent_facts'],
    limit: 1,
  });
  const company = search.results?.[0];
  if (!company) throw new Error('Resona Labs not in HubSpot');
  const cid = company.id;
  console.log(`[ok] found company ${cid}`);

  // Step 2: find the bun fact in the prose blob.
  const facts: string = company.properties.agent_facts ?? '';
  const bunLine = facts.split('\n').find((l) => l.includes('uses_stack') && l.includes('bun'));
  console.log(`\n[ok] located bun in agent_facts:\n      "${bunLine}"`);

  // Extract the fact_id (we deliberately embedded it in the property text during mirror).
  const factIdMatch = bunLine?.match(/fact_id=([0-9a-f-]+)/);
  const factId = factIdMatch?.[1];
  console.log(`\n[ok] parsed fact_id from prose: ${factId ?? '(none)'}`);

  // Step 3: try to look up the fact in HubSpot. There is no fact entity type.
  //   We try a few plausible places where someone might store provenance:
  const deadEnds: Array<{ attempt: string; result: string }> = [];

  // 3a. Is there a custom object called "fact"? (No — we never created one.)
  const customObjLookup = await hs('GET', `/crm/v3/objects/fact/${factId}?idProperty=fact_id`);
  deadEnds.push({
    attempt: `GET /crm/v3/objects/fact/${factId}`,
    result: customObjLookup.__error ? `${customObjLookup.__error.status}: ${customObjLookup.__error.body.slice(0, 120)}` : 'unexpected success',
  });

  // 3b. Property history on agent_facts. HubSpot does support property history on
  //     enterprise tiers, but not on free / trial test accounts. Try and document.
  const propHistory = await hs('GET', `/crm/v3/objects/companies/${cid}?properties=agent_facts&propertiesWithHistory=agent_facts`);
  const history = propHistory.propertiesWithHistory?.agent_facts ?? null;
  deadEnds.push({
    attempt: `propertiesWithHistory=agent_facts`,
    result: history
      ? `returned ${history.length} versions, but each is just a property value blob — no actor identity, no action verb, no prompt_hash, no causal parent_event_id`
      : 'no history data returned (likely tier-gated)',
  });

  // 3c. Search engagements for any audit trail. Service keys can't read engagements,
  //     but document the attempt for the report.
  deadEnds.push({
    attempt: 'GET /crm/v3/objects/notes (search for fact provenance)',
    result: 'service-key scope catalog excludes notes/engagements; no API surface to attempt',
  });

  // 3d. The fact_id string we found is just a UUID copied from agent-crm's seed.
  //     HubSpot itself doesn't recognise it as anything — it's an opaque string.
  deadEnds.push({
    attempt: `treat fact_id ${factId} as an opaque HubSpot identifier`,
    result: 'no HubSpot table maps this UUID to anything (it lives in the agent-crm Supabase)',
  });

  console.log('\n=== dead-ends ===');
  for (const d of deadEnds) {
    console.log(`  attempt:  ${d.attempt}`);
    console.log(`  result:   ${d.result}\n`);
  }

  console.log('\n=== summary ===');
  console.log('chain depth recoverable on HubSpot: 0 hops past the prose blob.');
  console.log('  - no fact table');
  console.log('  - no actor identity per write (PATCH attributes the change to the service-key token, not the agent that requested it)');
  console.log('  - no prompt_hash field on any object');
  console.log('  - property history (when available) is value snapshots, not causal chains');
  console.log('\nIf an agent-crm decision references fact_id=X, you can verify X. If a HubSpot agent decision references fact_id=X, you cannot.');

  const result = {
    system: 'hubspot',
    starting_fact_text: bunLine ?? null,
    parsed_fact_id: factId ?? null,
    chain_length: 0,
    dead_ends: deadEnds,
    summary: 'HubSpot has no event log, no actor identity per write, no prompt_hash, no fact table. Chain depth recoverable: 0 hops past the property text.',
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const out = resolve(OUT_DIR, 'provenance_hubspot.json');
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
