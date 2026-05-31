/**
 * Backfill: convert existing scalar relationship facts into object_entity edges.
 *
 * For each active text fact whose object resolves to an EXISTING entity (these
 * have no domain, so the resolver never creates — it only matches), assert an
 * edge fact that supersedes the text fact. Conservative: exact/domain matches
 * only (skip fuzzy in bulk to avoid false merges). Idempotent: already-converted
 * text facts are superseded, so excludeSuperseded drops them on re-run.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill_relationship_edges.ts          # dry run
 *   pnpm exec tsx scripts/backfill_relationship_edges.ts apply    # write edges
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { act, excludeSuperseded } from '@agent-crm/primitives';
import { resolveOrCreateEntity, looksLikeEntityName } from '@agent-crm/tools';

const APPLY = process.argv[2] === 'apply';

type F = { id: string; subject_entity: string; predicate: string; object_text: string; confidence: number; signal_id: string | null; supersedes: string | null };

// System/structural predicates whose object is never a relationship to another
// entity (is_a is a TYPE tag, email is an address, etc.). Not relationship
// vocabulary — excluding them doesn't constrain the open edge vocabulary.
const STRUCTURAL = new Set([
  'is_a', 'email', 'role', 'domain', 'icp_fit', 'icp_fit_breakdown',
  'contact_lookup_attempted', 'dropped_until', 'research_triggered', 'research_completed',
  'last_outreach_at', 'outreach_cooldown_until', 'outreach_rejected_at', 'no_reply_marked', 'replied_at',
]);
// Non-answer tokens that aren't entity names (catch mislabeled entities like the
// one literally named "Not specified").
const NON_ANSWER = new Set(['not specified', 'n/a', 'na', 'none', 'unknown', 'tbd', 'various', 'multiple', 'undisclosed', 'other']);

function skip(f: F): boolean {
  const t = (f.object_text ?? '').trim();
  if (!looksLikeEntityName(t)) return true;          // too long/short/sentence
  if (/^-?\d/.test(t)) return true;                  // numeric (scores, counts)
  if (t.startsWith('{') || t.startsWith('[')) return true; // json blobs
  if (f.predicate.startsWith('score_')) return true; // admin scores
  if (STRUCTURAL.has(f.predicate)) return true;      // type tags, addresses, admin
  if (NON_ANSWER.has(t.toLowerCase())) return true;  // non-answer values
  return false;
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  const actor = { workspace_id: ws, actor_kind: 'system' as const, actor_id: 'backfill-edges' };
  console.log(`workspace ${ws.slice(0, 8)} — mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  // all scalar facts
  const scalar: F[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await sb.from('facts').select('id, subject_entity, predicate, object_text, confidence, signal_id, supersedes')
      .eq('workspace_id', ws).is('object_entity', null).not('object_text', 'is', null).range(from, from + 999);
    const rows = (r.data ?? []) as F[];
    scalar.push(...rows);
    if (rows.length < 1000) break;
  }
  const active = await excludeSuperseded(sb, ws, scalar);
  const candidates = active.filter((f) => !skip(f));
  console.log(`scalar facts: ${scalar.length} | active: ${active.length} | name-like (attempting resolve): ${candidates.length}`);

  const conversions: Array<{ f: F; resolvedId: string; reason: string }> = [];
  let attempted = 0;
  for (const f of candidates) {
    attempted++;
    const res = await resolveOrCreateEntity(sb, actor, { name: f.object_text, object_type: 'account', subject_entity: f.subject_entity });
    // resolve-to-existing only: exact/domain (skip fuzzy in bulk), never created
    if (res.entity_id && !res.created && (res.reason === 'exact' || res.reason === 'domain')) {
      conversions.push({ f, resolvedId: res.entity_id, reason: res.reason });
    }
    if (attempted % 200 === 0) console.log(`  …resolved ${attempted}/${candidates.length}, ${conversions.length} matches so far`);
  }

  // resolve names for the report
  const nameById = new Map<string, string>();
  const ids = [...new Set(conversions.map((c) => c.resolvedId))];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await sb.from('entities').select('id, name').in('id', ids.slice(i, i + 200));
    for (const e of r.data ?? []) nameById.set(e.id as string, e.name as string);
  }
  const subjIds = [...new Set(conversions.map((c) => c.f.subject_entity))];
  for (let i = 0; i < subjIds.length; i += 200) {
    const r = await sb.from('entities').select('id, name').in('id', subjIds.slice(i, i + 200));
    for (const e of r.data ?? []) nameById.set(e.id as string, e.name as string);
  }

  console.log(`\n${conversions.length} text facts resolve to an existing entity:\n`);
  for (const c of conversions) {
    console.log(`  [${nameById.get(c.f.subject_entity) ?? c.f.subject_entity.slice(0, 8)}] --${c.f.predicate}--> "${c.f.object_text}"  =>  [${nameById.get(c.resolvedId) ?? c.resolvedId.slice(0, 8)}] (${c.reason})`);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with "apply" to convert these to edges.`);
    return;
  }

  let written = 0;
  for (const c of conversions) {
    try {
      await act(sb, actor, {
        tool: 'supersede_fact',
        args: {
          subject_entity: c.f.subject_entity,
          predicate: c.f.predicate,
          object_entity: c.resolvedId,
          confidence: c.f.confidence,
          supersedes: c.f.id,
          ...(c.f.signal_id ? { signal_id: c.f.signal_id } : {}),
        },
      });
      written++;
    } catch (e) {
      console.log(`  ! failed on fact ${c.f.id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\nAPPLIED — converted ${written}/${conversions.length} text facts to edges.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
