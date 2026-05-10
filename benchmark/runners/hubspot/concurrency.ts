/**
 * Concurrency benchmark runner: HubSpot side.
 *
 * 50 parallel writers each try to append a unique fact line to the company's
 * `agent_facts` property. Realistic read-modify-write pattern (HubSpot has no
 * append-only fact store).
 *
 * Each writer:
 *   1. GET company -> read current agent_facts
 *   2. Append "[concurrency_test_<run_tag>_<i>] ..."
 *   3. PATCH company { agent_facts: merged }
 *
 * Concurrent writers will overwrite each other's appends because each reads
 * the same starting state. We measure: of 50 attempted writes, how many lines
 * survive in the final agent_facts blob?
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
const CONCURRENCY = 50;
const ACCOUNT_NAME = 'Resona Labs';
const RUN_TAG = `concur_${Date.now().toString(36)}`;
const MARKER = `concurrency_test_${RUN_TAG}`;

async function hs(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${HS}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HS_TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HubSpot ${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function findCompanyId(name: string): Promise<string> {
  const search = await hs('POST', `/crm/v3/objects/companies/search`, {
    filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: name }] }],
    properties: ['name'],
    limit: 1,
  });
  const id = search.results?.[0]?.id;
  if (!id) throw new Error(`HubSpot company not found: ${name}`);
  return id;
}

async function appendFact(companyId: string, writerN: number): Promise<void> {
  // Read-modify-write: read current agent_facts, append new line, PATCH.
  const cur = await hs('GET', `/crm/v3/objects/companies/${companyId}?properties=agent_facts`);
  const existing: string = cur.properties?.agent_facts ?? '';
  const newLine = `[${MARKER}_${writerN}] writer_${writerN} test_value`;
  const merged = existing ? `${existing}\n${newLine}` : newLine;
  await hs('PATCH', `/crm/v3/objects/companies/${companyId}`, {
    properties: { agent_facts: merged },
  });
}

async function main() {
  const companyId = await findCompanyId(ACCOUNT_NAME);
  console.log(`hubspot company: ${companyId} (${ACCOUNT_NAME})\nrun_tag:         ${RUN_TAG}\n`);

  // Snapshot the starting agent_facts so we can subtract it from final count.
  const startState = await hs('GET', `/crm/v3/objects/companies/${companyId}?properties=agent_facts`);
  const startingFacts: string = startState.properties?.agent_facts ?? '';
  console.log(`starting agent_facts length: ${startingFacts.length} chars`);

  console.log(`\nfiring ${CONCURRENCY} parallel writers…`);
  const t0 = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENCY }, (_, i) => appendFact(companyId, i)),
  );
  const wall_ms = Date.now() - t0;
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = results.filter((r) => r.status === 'rejected');
  console.log(`  ${fulfilled} fulfilled, ${rejected.length} rejected, ${wall_ms} ms total`);
  if (rejected.length) {
    console.log('  rejection samples:', rejected.slice(0, 3).map((r: any) => r.reason?.message ?? r.reason));
  }

  // Read back and count distinct MARKER_<i> lines that survived.
  const final = await hs('GET', `/crm/v3/objects/companies/${companyId}?properties=agent_facts`);
  const finalFacts: string = final.properties?.agent_facts ?? '';
  const markerRegex = new RegExp(`\\[${MARKER}_(\\d+)\\]`, 'g');
  const survived = new Set<string>();
  for (const m of finalFacts.matchAll(markerRegex)) survived.add(m[1]!);

  const result = {
    system: 'hubspot',
    concurrency: CONCURRENCY,
    facts_attempted: CONCURRENCY,
    facts_persisted: survived.size,
    data_loss_count: CONCURRENCY - survived.size,
    data_loss_pct: ((CONCURRENCY - survived.size) / CONCURRENCY) * 100,
    wall_clock_ms: wall_ms,
    fulfilled,
    rejected: rejected.length,
    run_tag: RUN_TAG,
  };

  console.log(`\nhubspot concurrency result:`);
  console.log(`  attempted:     ${result.facts_attempted}`);
  console.log(`  persisted:     ${result.facts_persisted}`);
  console.log(`  data loss:     ${result.data_loss_count} (${result.data_loss_pct.toFixed(1)}%)`);
  console.log(`  wall clock:    ${result.wall_clock_ms} ms`);
  console.log(`  PATCH success: ${result.fulfilled} (HubSpot returned 200, but lost-update means most are silently overwritten)`);

  mkdirSync(OUT_DIR, { recursive: true });
  const out = resolve(OUT_DIR, 'concurrency_hubspot.json');
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
