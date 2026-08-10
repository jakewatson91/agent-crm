// One-off: Sudden's angles were regenerated and persisted a few minutes before
// stampRecordSince existed, so the rewritten technical_leader angle still carries
// the 183-fetched-0-kept record of the LinkedIn search it replaced. Stamp it now,
// using the pre-change strategy as the baseline, so the next regeneration judges
// the query that is actually running.
//
// Every other angle came back with its query unchanged, so it keeps counting
// everything, which is the record it has legitimately earned.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync } from 'node:fs';
import { createServerClient } from '@agent-crm/db';
import { stampRecordSince } from '@agent-crm/tools';
import type { ResearchAngle, WorkspacePolicy } from '../packages/tools/src/policy.ts';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const BACKUP = process.argv[2];

async function main() {
  if (!BACKUP) throw new Error('usage: _cfg_sudden_stamp_record_since.ts <pre-change policy backup json>');
  const before = (JSON.parse(readFileSync(BACKUP, 'utf8')) as WorkspacePolicy).research?.strategy ?? [];
  const sb = createServerClient();
  const { data, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const policy = (data.policy ?? {}) as WorkspacePolicy;
  const current = (policy.research?.strategy ?? []) as ResearchAngle[];
  if (current.some((a) => a.record_since)) { console.log('already stamped — nothing to do'); return; }

  const stamped = stampRecordSince(current, before);
  const next = { ...policy, research: { ...(policy.research ?? {}), strategy: stamped } };
  const { error: upErr } = await sb.from('workspaces').update({ policy: next }).eq('id', WS);
  if (upErr) throw upErr;
  for (const a of stamped) {
    console.log(`  ${a.id} [${a.domain_scope}] record_since=${a.record_since ?? '(unset — query unchanged, keeps its whole record)'}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
