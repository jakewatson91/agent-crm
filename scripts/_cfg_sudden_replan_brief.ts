/**
 * Put back the brief the blind regeneration dropped a question from, then let it
 * regenerate properly.
 *
 * ensureResearchBrief took `records` as an optional argument and no caller ever
 * passed one, so every regeneration in production ran without the track record
 * the guardrails read. One of them dropped monetization_model, a question sitting
 * below the fair-trial threshold that the guard exists to keep.
 *
 * ensureResearchBrief now loads the record itself, so this restores the brief as
 * it was before that regeneration and clears the input hash to force one more
 * pass. This time the planner sees each question's record and the 90-day floor.
 * The questions it returns are its own decision, not a hand-edit.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync } from 'node:fs';
import { createServerClient } from '@agent-crm/db';
import { ensureResearchBrief, ensureResearchStrategy, loadQuestionRecords } from '@agent-crm/tools';
import type { WorkspacePolicy } from '../packages/tools/src/policy.ts';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const backupPath = process.argv[2];
  if (!backupPath) throw new Error('usage: _cfg_sudden_replan_brief.ts <pre-change policy backup json>');
  const restored = (JSON.parse(readFileSync(backupPath, 'utf8')) as WorkspacePolicy).research?.brief ?? [];
  if (!restored.length) throw new Error('backup has no brief');

  const sb = createServerClient();
  const { data, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const policy = (data.policy ?? {}) as WorkspacePolicy;
  // A non-matching hash, NOT a missing one. isBriefCurrent treats an absent hash
  // as "a brief saved before hashing existed, keep it" and returns current, so
  // deleting the field pins the brief instead of replanning it.
  const research = { ...(policy.research ?? {}), brief: restored, brief_input_hash: 'force-replan' };
  const { error: upErr } = await sb.from('workspaces').update({ policy: { ...policy, research } }).eq('id', WS);
  if (upErr) throw upErr;
  console.log(`restored ${restored.length} questions, cleared the input hash`);

  console.log('\nthe record the planner will now see:');
  for (const r of await loadQuestionRecords(sb, WS)) {
    console.log(`  ${r.id.padEnd(20)} fetched=${String(r.fetched).padStart(4)} kept=${String(r.kept).padStart(3)} facts=${String(r.facts).padStart(3)} used=${r.used}`);
  }

  const brief = await ensureResearchBrief(sb, WS);
  console.log('\nAFTER brief');
  for (const q of brief) console.log(`  ${q.id.padEnd(20)} ${q.question}`);

  const angles = await ensureResearchStrategy(sb, WS);
  console.log('\nAFTER strategy');
  for (const a of angles) console.log(`  ${a.id.padEnd(26)} [${a.domain_scope}] answers=${a.answers ?? '-'}: ${a.query_template}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
