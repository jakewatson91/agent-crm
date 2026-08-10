/**
 * Would the evidence check have caught the LinkedIn angle, on real data?
 *
 * Assertions prove failedAngles against numbers I chose. This proves it against
 * the numbers production actually wrote, using the same functions the dispatcher
 * calls. Read-only, no LLM, no Exa, no writes.
 *
 * Two states are checked, and they must disagree:
 *   - the angle set as it was BEFORE today's fix (from the policy backup) must
 *     show linkedin_leadership as failed. That is the 14 days of waste the age-only
 *     staleness test allowed.
 *   - the angle set as it is NOW must show nothing failed, because the rewritten
 *     query's record_since reset its record. An angle that has just been rewritten
 *     must not immediately force another regeneration.
 *
 * Run: pnpm tsx scripts/_gq_27_evidence_stale.ts <pre-change policy backup json>
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync } from 'node:fs';
import { createServerClient } from '@agent-crm/db';
import { getPolicy, loadAngleRecords, failedAngles, type AngleRecord } from '@agent-crm/tools';
import type { ResearchAngle, WorkspacePolicy } from '../packages/tools/src/policy.ts';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

/**
 * Sum per-angle fetched/kept for runs BEFORE a cutoff.
 *
 * loadAngleRecords deliberately has no upper bound — it answers "what is this
 * angle buying now". Reconstructing the pre-fix record needs the opposite, and
 * the two cannot be the same call: the rewritten angle KEPT its id, so anything
 * unbounded above counts today's working search as part of the broken one's
 * record. That is what made the first version of this check pass nothing.
 */
async function recordsBefore(sb: ReturnType<typeof createServerClient>, cutoff: string, angles: ResearchAngle[]): Promise<AngleRecord[]> {
  const { data } = await sb.from('events').select('payload, created_at')
    .eq('workspace_id', WS).eq('action', 'research_completed')
    .lt('created_at', cutoff).order('created_at', { ascending: false }).limit(5000);
  const fetched: Record<string, number> = {};
  for (const e of (data ?? []) as Array<{ payload: any }>) {
    for (const [k, v] of Object.entries(e.payload?.per_angle_fetched ?? {})) fetched[k] = (fetched[k] ?? 0) + (Number(v) || 0);
  }
  // Same measure loadAngleRecords uses: kept AS ANSWERING the angle's own
  // question, read off the signals. Counting pages kept for any question puts
  // this angle at 16 and hides the failure completely.
  const answersOf = new Map(angles.map((a) => [a.id, a.answers]));
  const kept: Record<string, number> = {};
  for (let from = 0; ; from += 1000) {
    const { data: sigs } = await sb.from('signals').select('structured_tags')
      .eq('workspace_id', WS).eq('type', 'research_result')
      .lt('observed_at', cutoff).range(from, from + 999);
    for (const s of (sigs ?? []) as Array<{ structured_tags: Record<string, string> | null }>) {
      const angleId = s.structured_tags?.research_angle;
      if (!angleId || !answersOf.has(angleId)) continue;
      const wants = answersOf.get(angleId);
      if (wants && s.structured_tags?.answers_question !== wants) continue;
      kept[angleId] = (kept[angleId] ?? 0) + 1;
    }
    if (!sigs || sigs.length < 1000) break;
  }
  return [...new Set([...Object.keys(fetched), ...Object.keys(kept)])]
    .map((id) => ({ id, fetched: fetched[id] ?? 0, kept: kept[id] ?? 0 }));
}

async function report(sb: ReturnType<typeof createServerClient>, label: string, angles: ResearchAngle[], records: AngleRecord[]) {
  const byId = new Map(records.map((r) => [r.id, r]));
  console.log(`\n=== ${label} ===`);
  for (const a of angles) {
    const r = byId.get(a.id);
    const hit = r?.fetched ? `${Math.round((r.kept / r.fetched) * 100)}%` : '-';
    console.log(`  ${a.id.padEnd(26)} [${a.domain_scope.padEnd(8)}] answers=${(a.answers ?? '-').padEnd(18)} since=${a.record_since?.slice(0, 10) ?? 'all time'}  ${r?.fetched ?? 0} fetched, ${r?.kept ?? 0} answered it (${hit})`);
  }
  const failed = failedAngles(angles, records);
  console.log(`  -> forces a regeneration: ${failed.length ? failed.join(', ') : 'nothing'}`);
  return failed;
}

async function main() {
  const backupPath = process.argv[2];
  if (!backupPath) throw new Error('usage: _gq_27_evidence_stale.ts <pre-change policy backup json>');
  const sb = createServerClient();

  const before = (JSON.parse(readFileSync(backupPath, 'utf8')) as WorkspacePolicy).research?.strategy ?? [];
  const now = (await getPolicy(sb, WS)).research?.strategy ?? [];
  const cutoff = now.find((a) => a.record_since)?.record_since;
  if (!cutoff) throw new Error('no rewritten angle to measure against');

  const failedBefore = await report(sb, `BEFORE the fix (runs before ${cutoff.slice(0, 16)})`, before, await recordsBefore(sb, cutoff, before));
  const failedNow = await report(sb, 'NOW (angles as persisted, each read from its own record_since)', now, await loadAngleRecords(sb, WS, now));

  const ok = failedBefore.includes('linkedin_leadership') && failedNow.length === 0;
  console.log(`\n${ok ? 'PASS' : 'FAIL'} — the old angle set forces a rewrite, the rewritten one does not`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
