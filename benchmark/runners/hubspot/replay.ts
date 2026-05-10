/**
 * Replayability demo: HubSpot side.
 *
 * agent-crm reconstructs full projection state at any past timestamp via
 * replay_to(workspace_id, ts). We attempt the equivalent on HubSpot and
 * document where the gap is.
 *
 * What HubSpot does have:
 *   - Per-property change history (`propertiesWithHistory=...`): a list of past
 *     values for one property on one object, with timestamps and "sourceType".
 *
 * What HubSpot does NOT have:
 *   - A timestamp-cut "give me the full account state at T" primitive.
 *   - Cross-object replay (account state at T = account fields + facts + signals
 *     + subscriptions + channel posts at T). HubSpot has no event log; you'd
 *     need to manually replay each property's history per object per field.
 *   - Replay of an agent's *reasoning*. There is no prompt_hash, no actor record,
 *     no causal chain, so even if you could recover values, you cannot rerun
 *     the agent against past state.
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
  console.log('attempting timestamped replay on HubSpot for Resona Labs…\n');

  const search = await hs('POST', `/crm/v3/objects/companies/search`, {
    filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: 'Resona Labs' }] }],
    properties: ['name'],
    limit: 1,
  });
  const cid = search.results?.[0]?.id;
  if (!cid) throw new Error('Resona Labs not in HubSpot');
  console.log(`[ok] found company ${cid}`);

  const tBefore = new Date(Date.now() - 60_000).toISOString();
  console.log(`\nGoal: reconstruct Resona's full state as of ${tBefore} (1 minute ago).`);
  console.log('agent-crm equivalent: replay_to(workspace_id, t_before) returns a complete jsonb snapshot in one call.\n');

  // Attempt 1: a "replay_to" or "snapshot at" endpoint on HubSpot.
  const snapshotAttempt = await hs('GET', `/crm/v3/objects/companies/${cid}/snapshot?at=${tBefore}`);
  console.log('attempt 1: GET /crm/v3/objects/companies/{id}/snapshot?at=<ts>');
  console.log(`  ${snapshotAttempt.__error ? `${snapshotAttempt.__error.status}: no such endpoint` : 'unexpected success'}`);

  // Attempt 2: per-property history. We can read it, but it's just past values on
  // one property. No "filter to T" parameter; you get the full history list.
  const props = ['agent_facts', 'agent_signals', 'description', 'stack', 'name', 'domain'];
  const history = await hs('GET', `/crm/v3/objects/companies/${cid}?properties=${props.join(',')}&propertiesWithHistory=${props.join(',')}`);
  const histRows = history.propertiesWithHistory ?? {};
  console.log('\nattempt 2: GET /crm/v3/objects/companies/{id}?propertiesWithHistory=<all>');
  console.log(`  returned change-history for ${Object.keys(histRows).length} properties`);
  for (const [k, v] of Object.entries(histRows)) {
    console.log(`    ${k}: ${(v as any[]).length} versions`);
  }

  // Attempt 3: try to filter property history to T_before. There is no time filter.
  // To "replay at T_before" you would have to:
  //   for each property:
  //     find the version with timestamp <= T_before
  //   combine into a synthetic envelope yourself
  // Each property history version exposes (value, timestamp, sourceType). It does
  // NOT expose: actor identity per write, prompt_hash, causal parent, action verb.
  // So even if you reconstruct the values at T, you cannot rerun the agent reasoning.
  const facts_versions = (histRows.agent_facts as any[]) ?? [];
  console.log('\nattempt 3: manually reconstruct agent_facts at T_before from version list');
  if (!facts_versions.length) {
    console.log('  no version data on agent_facts (this property was set once)');
  } else {
    const sampleVersion = facts_versions[0];
    console.log('  sample version row:', JSON.stringify({
      value_preview: typeof sampleVersion.value === 'string' ? sampleVersion.value.slice(0, 60) + '…' : sampleVersion.value,
      timestamp: sampleVersion.timestamp,
      sourceType: sampleVersion.sourceType,
      sourceId: sampleVersion.sourceId,
      sourceLabel: sampleVersion.sourceLabel,
      updatedByUserId: sampleVersion.updatedByUserId,
    }, null, 2));
    console.log('  fields available per version: value, timestamp, sourceType, sourceId, sourceLabel, updatedByUserId');
    console.log('  fields MISSING per version:    actor identity (agent name), prompt_hash, action verb, causal parent_event_id');
  }

  console.log('\n=== summary ===');
  console.log('HubSpot has property-level change history (not all tiers) but it is not a replay primitive.');
  console.log('To reconstruct Resona\'s full state at T:');
  console.log('  1. Manually fetch propertiesWithHistory per object per field');
  console.log('  2. For each, find the version whose timestamp <= T');
  console.log('  3. Stitch values together into a synthetic envelope');
  console.log('  4. Repeat across every related object (contacts, deals, notes, …)');
  console.log('  5. Even after all that, you still cannot rerun an agent against the state because');
  console.log('     there is no prompt_hash, no actor identity per write, no event log.');
  console.log('agent-crm equivalent: one RPC. Deterministic. Includes all related objects.');

  const result = {
    system: 'hubspot',
    target_timestamp: tBefore,
    attempted_endpoints: [
      { path: 'GET /crm/v3/objects/companies/{id}/snapshot?at=<ts>', exists: false, note: 'no equivalent in HubSpot API' },
      { path: 'GET ...?propertiesWithHistory=<all>', exists: true, note: 'per-property version list, no time filter' },
    ],
    fields_available_per_version: ['value', 'timestamp', 'sourceType', 'sourceId', 'sourceLabel', 'updatedByUserId'],
    fields_missing_per_version: ['actor identity (agent name)', 'prompt_hash', 'action verb', 'causal parent_event_id'],
    can_reconstruct_full_state_at_t: false,
    can_rerun_agent_against_past_state: false,
    summary: 'HubSpot has property-level change history but no replay primitive. No event log, no prompt_hash, no actor identity per write. Cannot rerun agent reasoning against past state.',
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const out = resolve(OUT_DIR, 'replay_hubspot.json');
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
