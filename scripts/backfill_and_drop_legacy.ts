/**
 * One-shot cleanup of the demo workspace's legacy entities.
 *
 * 1. For each entity with yc_slug: re-fetch the YC directory, merge any
 *    missing/stale canonical ground-truth keys (team_size, stage, industry,
 *    location) into entity.attributes. Idempotent: only writes when the
 *    merged object differs from existing.
 *
 * 2. For each entity without yc_slug: assert a far-future dropped_until fact
 *    (2100-01-01). scoreAndAssert + action_selector skip dropped entities, so
 *    they stop consuming LLM calls / agent attention. They remain in the DB,
 *    queryable, and can be lifted by superseding the fact when wanted.
 *    Idempotent: skips entities that already have an active dropped_until.
 */
import { createServerClient } from '@agent-crm/db';
import { callTool } from '@agent-crm/tools';

const YC_ALL_URL = 'https://yc-oss.github.io/api/companies/all.json';
const DROP_UNTIL = '2100-01-01T00:00:00.000Z';
const WS_ID = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

interface YcCompany {
  slug: string;
  team_size?: number;
  stage?: string;
  industry?: string;
  all_locations?: string;
  status?: string;
  isHiring?: boolean;
  one_liner?: string;
}

async function main() {
  const sb = createServerClient();

  console.log('--- fetching YC directory ---');
  const r = await fetch(YC_ALL_URL);
  if (!r.ok) throw new Error(`yc fetch ${r.status}`);
  const ycRows = (await r.json()) as YcCompany[];
  const bySlug = new Map<string, YcCompany>();
  for (const c of ycRows) if (c.slug) bySlug.set(c.slug, c);
  console.log('yc directory rows:', ycRows.length);

  const all = await sb.from('entities').select('id, name, attributes')
    .eq('workspace_id', WS_ID).eq('kind', 'account');
  const ents = all.data ?? [];
  console.log('total accounts in workspace:', ents.length);

  // ---- 1. YC backfill ----
  let ycBackfilled = 0;
  let ycMissingFromDirectory = 0;
  let ycUnchanged = 0;
  const ycEnts = ents.filter((e) => (e.attributes as any)?.yc_slug);
  for (const e of ycEnts) {
    const attrs = { ...((e.attributes ?? {}) as Record<string, unknown>) };
    const slug = attrs.yc_slug as string;
    const yc = bySlug.get(slug);
    if (!yc) { ycMissingFromDirectory++; continue; }

    // Merge: prefer YC value when present, else keep existing.
    const merged = { ...attrs };
    let changed = false;
    const pairs: Array<[string, unknown]> = [
      ['team_size', yc.team_size ?? null],
      ['stage', yc.stage ?? null],
      ['industry', yc.industry ?? null],
      ['location', yc.all_locations ?? null],
      ['is_hiring', yc.isHiring ?? false],
      ['yc_status', yc.status ?? null],
      ['one_liner', yc.one_liner ?? attrs.one_liner ?? null],
    ];
    for (const [k, v] of pairs) {
      if (v !== null && v !== undefined && merged[k] !== v) {
        merged[k] = v;
        changed = true;
      }
    }
    if (!changed) { ycUnchanged++; continue; }

    const upd = await sb.from('entities').update({ attributes: merged }).eq('id', e.id);
    if (upd.error) console.log('  upd err', e.name, upd.error.message);
    else ycBackfilled++;
  }
  console.log(`yc: backfilled=${ycBackfilled} unchanged=${ycUnchanged} missing_from_directory=${ycMissingFromDirectory}`);

  // ---- 2. Non-YC drop ----
  const nonYc = ents.filter((e) => !(e.attributes as any)?.yc_slug);
  const nonYcIds = nonYc.map((e) => e.id as string);

  // Skip entities already dropped (active dropped_until in the future).
  const dropFacts = await sb.from('facts').select('subject_entity, object_text')
    .eq('workspace_id', WS_ID).eq('predicate', 'dropped_until')
    .is('supersedes', null)
    .in('subject_entity', nonYcIds);
  const alreadyDroppedIds = new Set<string>();
  const now = Date.now();
  for (const f of dropFacts.data ?? []) {
    const t = Date.parse(f.object_text as string);
    if (Number.isFinite(t) && t > now) alreadyDroppedIds.add(f.subject_entity as string);
  }

  const toDrop = nonYc.filter((e) => !alreadyDroppedIds.has(e.id as string));
  console.log(`non-yc: total=${nonYc.length} already_dropped=${alreadyDroppedIds.size} to_drop=${toDrop.length}`);

  const actor = { workspace_id: WS_ID, actor_kind: 'system' as const, actor_id: 'cleanup:drop_legacy' };
  let dropped = 0;
  let dropErrors = 0;
  for (const e of toDrop) {
    const created = await callTool(sb, actor, 'assert_fact', {
      subject_entity: e.id as string,
      predicate: 'dropped_until',
      object_text: DROP_UNTIL,
      confidence: 1.0,
    });
    if (created.ok) dropped++;
    else { dropErrors++; if (dropErrors <= 3) console.log('  drop err', e.name, created.error); }
  }
  console.log(`dropped=${dropped} errors=${dropErrors}`);

  console.log('\n--- done ---');
  console.log(`YC backfilled: ${ycBackfilled}`);
  console.log(`Non-YC dropped: ${dropped}`);
  console.log(`Active attention pool: ${ycEnts.length - ycMissingFromDirectory} YC entities`);
}

main().catch((e) => { console.error(e); process.exit(1); });
