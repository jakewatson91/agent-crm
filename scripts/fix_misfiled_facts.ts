/**
 * Move facts that were filed under the wrong predicate to the right one.
 *
 * Two kinds found by scripts/_sweep_company_description.ts, both sitting in
 * `company_description`, which the ICP rubric reads as "what this company does":
 *
 *   1. A contact's profile bio. Minutus Computing scored industry_match 0 —
 *      "a consulting firm focused on packaging and sustainability" — off a
 *      person's LinkedIn About section. Moved to `misfiled_person_bio`, which is
 *      in ADMIN_PREDICATES so it is neither read as company info nor counted as
 *      evidence_depth.
 *   2. A hand-written sales note. GammaTime's value is "Ex-Google Gaming +
 *      ex-Quibi background = will understand CDN offload math instantly."
 *      That is genuinely useful, just not a company description. Moved to
 *      `prospect_notes`, where the drafter already reads it as context.
 *
 * Nothing is deleted. Each fact is superseded by a new one carrying the same
 * text under the correct predicate, so the original stays in the chain and the
 * move is auditable and reversible.
 *
 * The classification is NOT a heuristic. The ids below were read individually
 * and each is listed with the reason, because a wrong move here silently edits
 * what the scorer believes about a real account.
 *
 * Usage: tsx scripts/fix_misfiled_facts.ts           (dry run)
 *        tsx scripts/fix_misfiled_facts.ts --apply
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { callTool } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.WORKSPACE_ID ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const APPLY = process.argv.includes('--apply');

/** fact_id -> predicate it should have carried. */
const MOVES: Array<{ id: string; to: string; account: string }> = [
  { id: '029c803d-3961-4115-876c-19cc8a3480b2', to: 'misfiled_person_bio', account: 'Accedo TV' },
  { id: '10861e56-1a6c-49c7-a5a4-d36d1160f2a9', to: 'misfiled_person_bio', account: 'Ross Video' },
  { id: '3fc002a8-ba82-4b54-ad9e-3f0a096213be', to: 'misfiled_person_bio', account: 'Verizon' },
  { id: '532ad8ec-a0a0-48b1-b3ed-598b7d0fc83e', to: 'misfiled_person_bio', account: 'AWS' },
  { id: '556bba75-549b-474c-941d-645e540c770b', to: 'misfiled_person_bio', account: 'AWS' },
  { id: '78a4bb9d-48b8-4c52-8a41-7f7f2b790ebc', to: 'misfiled_person_bio', account: 'Pluto TV' },
  { id: '80479ee0-88bb-4063-b4ee-ddffed26d2ca', to: 'misfiled_person_bio', account: 'Everyone TV' },
  { id: '882c61c2-5a0d-4d9b-98b6-22e965a2c950', to: 'misfiled_person_bio', account: 'Minutus Computing' },
  { id: 'a2753099-8959-4af6-a6db-2ed33d6cb491', to: 'misfiled_person_bio', account: 'TVU Networks' },
  { id: 'ba0aa9fc-3300-46da-9cf7-d39f229909ac', to: 'misfiled_person_bio', account: 'Greening of Streaming' },
  { id: 'da98eaad-c83f-483b-85b9-50c12927d9b9', to: 'misfiled_person_bio', account: 'Prime Video' },
  { id: 'f71bfd8c-6ca6-409c-bed8-c09b7ad9864a', to: 'misfiled_person_bio', account: 'EstateMin' },
  // Not a bio: a sales note about the buyer, useful to the drafter as context.
  { id: '3592577b-8e31-470c-8104-b8c9f19f912a', to: 'prospect_notes', account: 'GammaTime' },
];

async function main() {
  const ids = MOVES.map((m) => m.id);
  const { data, error } = await sb.from('facts')
    .select('id, subject_entity, predicate, object_text, confidence, supersedes')
    .eq('workspace_id', WS).in('id', ids);
  if (error) throw error;
  const byId = new Map(((data ?? []) as Array<Record<string, unknown>>).map((r) => [r.id as string, r]));

  const actor = { workspace_id: WS, actor_kind: 'system' as const, actor_id: 'fix_misfiled_facts' };
  let moved = 0, skipped = 0;

  for (const m of MOVES) {
    const row = byId.get(m.id);
    if (!row) { console.log(`  SKIP ${m.account}: fact ${m.id.slice(0, 8)} not found`); skipped++; continue; }
    if (row.predicate !== 'company_description') { console.log(`  SKIP ${m.account}: already ${row.predicate}`); skipped++; continue; }

    // A superseded row is no longer active; moving it would resurrect nothing.
    const already = ((data ?? []) as Array<{ supersedes?: string }>).some((r) => r.supersedes === m.id);
    if (already) { console.log(`  SKIP ${m.account}: already superseded`); skipped++; continue; }

    console.log(`  ${m.account.padEnd(24)} company_description -> ${m.to}`);
    console.log(`      ${String(row.object_text).slice(0, 110).replace(/\s+/g, ' ')}…`);
    if (!APPLY) continue;

    const res = await callTool(sb, actor, 'supersede_fact', {
      subject_entity: row.subject_entity as string,
      predicate: m.to,
      object_text: row.object_text as string,
      confidence: typeof row.confidence === 'number' ? row.confidence : 0.9,
      supersedes: m.id,
    });
    if (!res.ok) { console.log(`      FAILED: ${res.error}`); skipped++; continue; }
    moved++;
  }

  console.log(`\n${moved} moved, ${skipped} skipped, ${MOVES.length} listed`);
  if (!APPLY) console.log('DRY RUN. Re-run with --apply to write.');
  else console.log('Affected accounts will re-rubric on their next scoring run: the fact set changed, so inputs_hash changes.');
}
main().catch((e) => { console.error(e); process.exit(1); });
