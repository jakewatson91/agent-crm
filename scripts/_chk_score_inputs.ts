import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { excludeSuperseded } from '@agent-crm/primitives';

/**
 * Does score_inputs() return exactly what scoreEntity used to fetch itself?
 *
 * The migration is a transport change: nine to twelve PostgREST calls per
 * entity collapsed into one function. That is only safe if the bundle is
 * byte-identical to what the client assembled, so this runs BOTH paths against
 * live rows and diffs them. Run it before trusting the RPC, and again after any
 * edit to the function body.
 *
 *   npx tsx scripts/_chk_score_inputs.ts [n]
 */

const sb = createServerClient();
const ws = process.env.WORKSPACE_ID!;

const ids = (rows: Array<Record<string, unknown>> | null, key = 'id') =>
  (rows ?? []).map((r) => String(r[key])).sort();

/** The reads scoreEntity + graphProximity issued before 0059. */
async function clientSide(entity_id: string) {
  const [entRes, factsRes, worksAtRes] = await Promise.all([
    sb.from('entities').select('id, name, attributes').eq('id', entity_id).maybeSingle(),
    sb.from('facts').select('id, predicate, object_text, confidence, observed_at, created_at, supersedes, signal_id')
      .eq('workspace_id', ws).eq('subject_entity', entity_id).order('observed_at', { ascending: false }),
    sb.from('facts').select('subject_entity')
      .eq('workspace_id', ws).eq('predicate', 'works_at').eq('object_entity', entity_id).is('supersedes', null),
  ]);
  const subjRes = await sb.from('facts').select('id, predicate, object_entity, supersedes')
    .eq('workspace_id', ws).eq('subject_entity', entity_id).not('object_entity', 'is', null);
  const subjEdges = await excludeSuperseded(sb, ws, (subjRes.data ?? []) as Array<{ id: string }>);
  const objRes = await sb.from('facts').select('id, predicate, subject_entity, supersedes')
    .eq('workspace_id', ws).eq('object_entity', entity_id);
  const objEdges = await excludeSuperseded(sb, ws, (objRes.data ?? []) as Array<{ id: string }>);

  const neighbours = [...new Set([
    ...subjEdges.map((e) => String((e as Record<string, unknown>).object_entity)),
    ...objEdges.map((e) => String((e as Record<string, unknown>).subject_entity)),
  ])];
  let fits: Array<{ id: string }> = [];
  if (neighbours.length) {
    const fitsRes = await sb.from('facts').select('id, subject_entity, object_text, supersedes')
      .eq('workspace_id', ws).eq('predicate', 'icp_fit').in('subject_entity', neighbours);
    fits = await excludeSuperseded(sb, ws, (fitsRes.data ?? []) as Array<{ id: string }>);
  }

  const contactIds = ((worksAtRes.data ?? []) as Array<{ subject_entity: string }>).map((r) => r.subject_entity);
  let contactFacts: Array<Record<string, unknown>> = [];
  let contactNames: Array<Record<string, unknown>> = [];
  if (contactIds.length) {
    const [cf, ce] = await Promise.all([
      sb.from('facts').select('id, subject_entity, predicate, object_text, observed_at, supersedes')
        .eq('workspace_id', ws).in('subject_entity', contactIds),
      sb.from('entities').select('id, name').in('id', contactIds),
    ]);
    contactFacts = (cf.data ?? []) as Array<Record<string, unknown>>;
    contactNames = (ce.data ?? []) as Array<Record<string, unknown>>;
  }
  return {
    entity: entRes.data ? String((entRes.data as { id: string }).id) : null,
    facts: ids(factsRes.data as Array<Record<string, unknown>>),
    fact_order: ((factsRes.data ?? []) as Array<{ id: string }>).map((f) => f.id),
    subj_edges: ids(subjEdges as Array<Record<string, unknown>>),
    obj_edges: ids(objEdges as Array<Record<string, unknown>>),
    fits: ids(fits as Array<Record<string, unknown>>),
    contact_ids: [...contactIds].sort(),
    contact_facts: ids(contactFacts),
    contact_names: ids(contactNames),
  };
}

function fromBundle(b: Record<string, Array<Record<string, unknown>>> & { entity?: { id: string } | null }) {
  return {
    entity: b.entity ? String(b.entity.id) : null,
    facts: ids(b.facts),
    fact_order: (b.facts ?? []).map((f) => String(f.id)),
    subj_edges: ids(b.subj_edges),
    obj_edges: ids(b.obj_edges),
    fits: ids(b.fits),
    contact_ids: ((b.contact_ids ?? []) as unknown as string[]).map(String).sort(),
    contact_facts: ids(b.contact_facts),
    contact_names: ids(b.contact_names),
  };
}

async function main() {
  const n = Number(process.argv[2] ?? 25);
  // entities that actually exercise the joins, not empty seed rows
  const { data: withEdges } = await sb.from('facts').select('subject_entity')
    .eq('workspace_id', ws).not('object_entity', 'is', null).limit(400);
  const { data: withContacts } = await sb.from('facts').select('object_entity')
    .eq('workspace_id', ws).eq('predicate', 'works_at').is('supersedes', null).limit(200);
  const pool = [...new Set([
    ...((withContacts ?? []) as Array<{ object_entity: string }>).map((r) => r.object_entity),
    ...((withEdges ?? []) as Array<{ subject_entity: string }>).map((r) => r.subject_entity),
  ])].filter(Boolean).slice(0, n);

  let mismatched = 0;
  let capExposed = 0;
  for (const id of pool) {
    const [a, rpc] = await Promise.all([clientSide(id), sb.rpc('score_inputs', { p_workspace: ws, p_entity: id })]);
    if (rpc.error) { console.error(`RPC FAILED ${id}: ${rpc.error.message}`); mismatched++; continue; }
    const b = fromBundle(rpc.data as never);
    for (const k of Object.keys(a) as Array<keyof typeof a>) {
      if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;

      // The one difference we accept, and only in this exact shape: PostgREST
      // caps a select at 1000 rows, so an account with enough contact facts
      // got a truncated, arbitrarily-ordered slice. The function has no cap, so
      // it returns the whole set the code always meant to read ("the 3 most
      // recent qualifying facts across every linked contact"). Measured on
      // 2026-09-01: 1 account of 129, 1,683 facts of which the client saw
      // 1,000. Anything other than a strict superset at exactly 1000 is a bug.
      const truncated = k === 'contact_facts' && a[k].length === 1000;
      const superset = truncated && (a[k] as string[]).every((x) => (b[k] as string[]).includes(x));
      if (superset) {
        capExposed++;
        console.log(`NOTE ${id} .contact_facts: client capped at 1000, function returned ${b[k].length} (superset)`);
        continue;
      }

      mismatched++;
      console.error(`MISMATCH ${id} .${k}`);
      console.error(`  client: ${JSON.stringify(a[k]).slice(0, 220)}`);
      console.error(`  rpc   : ${JSON.stringify(b[k]).slice(0, 220)}`);
    }
  }
  console.log(`${pool.length} entities compared across 9 fields, ${mismatched} mismatches, ${capExposed} capped-read differences`);
  if (mismatched) process.exit(1);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
