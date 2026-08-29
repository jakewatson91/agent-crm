/**
 * Repoint one search angle at the brief question it was written for.
 *
 * `tech_leader_blog` searches an engineering blog for delivery-scaling talk,
 * which is the technical_leader question, but its `answers` field said
 * `recent_launch` — a question that already had its own search. So Sudden paid
 * for five searches a company and covered four questions, and the health sweep
 * reported technical_leader as having no search behind it.
 *
 * Only the mapping changes. The query template is already right for the
 * question, so it is left alone.
 *
 * NOTE: the planner rewrites every angle when the strategy goes stale
 * (14 days, so ~2026-09-08 from the 08-25 generation). It can reintroduce the
 * same mismatch; re-run this then, or check coverage after a regeneration.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const WORKSPACE = 'Sudden';
const ANGLE_ID = 'tech_leader_blog';
const NEW_ANSWERS = 'technical_leader';

async function main() {
  const { data: ws } = await sb.from('workspaces').select('id,policy').eq('name', WORKSPACE).maybeSingle();
  if (!ws) throw new Error(`workspace ${WORKSPACE} not found`);

  const policy = (ws.policy ?? {}) as Record<string, any>;
  const angles: any[] = policy.research?.strategy ?? [];
  const target = angles.find((a) => a.id === ANGLE_ID);
  if (!target) throw new Error(`angle ${ANGLE_ID} not found (have: ${angles.map((a) => a.id).join(', ')})`);

  // The question must exist in the brief, or we'd point the search at nothing.
  const briefIds: string[] = (policy.research?.brief ?? []).map((q: any) => q.id);
  if (!briefIds.includes(NEW_ANSWERS)) {
    throw new Error(`brief has no question "${NEW_ANSWERS}" (has: ${briefIds.join(', ')})`);
  }

  console.log(`before: ${target.id}.answers = ${JSON.stringify(target.answers)}`);
  if (target.answers === NEW_ANSWERS) {
    console.log('already correct, nothing to do');
  } else {
    target.answers = NEW_ANSWERS;
    const next = { ...policy, research: { ...policy.research, strategy: angles } };
    const { error } = await sb.from('workspaces').update({ policy: next }).eq('id', ws.id);
    if (error) throw error;
    console.log(`after:  ${target.id}.answers = ${JSON.stringify(NEW_ANSWERS)}`);
  }

  // Read back from the DB and report coverage per question.
  const { data: check } = await sb.from('workspaces').select('policy').eq('id', ws.id).maybeSingle();
  const saved = (check!.policy ?? {}) as Record<string, any>;
  const cover: Record<string, string[]> = {};
  for (const q of saved.research?.brief ?? []) cover[q.id] = [];
  for (const a of saved.research?.strategy ?? []) (cover[a.answers] ??= []).push(a.id);
  console.log('\nquestion coverage:');
  for (const [q, as] of Object.entries(cover)) {
    console.log(`  ${as.length ? '✓' : '✗'} ${q}: ${as.join(', ') || 'NO SEARCH'}`);
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
